/**
 * レコーザーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終確定
 *
 * 🛠 方式B対応版：
 * ・音声本体は録音中に GAS へ随時「独立チャンクとして保存」される前提。
 *   そのため停止時に巨大な音声Blobをまるごと送る必要がなくなった。
 *
 * 🛠 音声優先確定対応：
 * ・音声結合（finalizeAudio）を、文字起こし処理より「先に・独立して」実行する。
 *   ねらい：文字起こし・議事録生成がスリープや通信断でエラーになっても、
 *   音声さえ1本のファイルとして確定していれば、他の手段で後から議事録化できる。
 *
 * 🛠 重要なバグ修正（チャンク単位の個別文字起こしを廃止）：
 * ・従来は録音中、10分ごとのチャンクを「個別に」Gemini File APIへ送って
 *   文字起こしする方式（addTranscribeChunk / processAllChunks / 
 *   sendChunkWithRetry）だった。
 *   しかし、MediaRecorderのtimeslice方式では「最初のチャンクだけが正しい
 *   WebMヘッダーを持ち、2個目以降はヘッダーを持たない継続データの断片」
 *   でしかないため、これを単体でGeminiに渡すと、Geminiが不完全な音声を
 *   無理に解釈しようとし、「同一発言の重複」「文脈の破綻」といった
 *   誤った文字起こし結果を生む不具合が実際に確認された。
 *
 * 🛠 2時間超の長時間録音への抜本対応（逐次アップロード方式）：
 * ・GASのBlobサイズ上限（約50MB）、およびGASの実行時間制限（6分）という
 *   2つの制約により、「音声を1本に結合してから文字起こしする」方式は
 *   長時間録音では破綻する（GASのメモリ枯渇、または6分タイムアウト）。
 * ・対策として、フロント側は「timesliceによる分割」をやめ、10分ごとに
 *   MediaRecorderを「完全停止→即再開」する方式に変更した。これにより
 *   すべてのチャンクが「正しいヘッダーを持つ、完全で独立した1本の
 *   WebMファイル」として生成される。
 * ・各チャンクは、生成された直後に非同期でGASへ送信し、Gemini File API
 *   へアップロードする（uploadChunkToGemini）。返ってきたfileUriは
 *   localStorageに配列として蓄積する（geminiFileUris）。
 * ・録音終了時は、重い音声データを一切送らず、蓄積されたfileUriの配列
 *   だけをGASへ渡して文字起こしを行う（transcribeFromMultipleFiles）。
 *   この処理はfileUriを参照するだけなので高速に完了し、GASの6分制限に
 *   余裕を持って収まる。
 * ・音声のDrive保存（appendAudioChunk/finalizeAudio）とGeminiアップロード
 *   （uploadChunkToGemini）は、目的が異なるため両方並行して行う：
 *     - Drive保存: 人間が後で聞き直すための「永続的な原本バックアップ」
 *     - Geminiアップロード: AIに文字起こしさせるための「一時的な計算用
 *       リソース」（48時間で自動失効）
 * ・fileUri配列がlocalStorageに永続化されているため、スリープ等で
 *   アプリが一時的に落ちても「重い音声の再アップロード」というボトル
 *   ネックをスキップして、即座に文字起こしから再開できる
 *   （「お助けモード」との統合）。
 *
 * ・addTranscribeChunk / processAllChunks / sendChunkWithRetry /
 *   transcribeFinalizedAudio は、後方互換のためコードとしては残して
 *   いるが、通常フローからは呼び出さない（呼び出し箇所はHTML側から
 *   削除済み）。
 */

const CONFIG = {
    GAS_URL: localStorage.getItem('saved_gas_url') || "",
    MAX_RETRIES: 3,
    STORAGE_KEY: "recorder_app_state"
};

class RecorderController {
    constructor(config) {
        this.gasUrl = config.GAS_URL;
        this.maxRetries = config.MAX_RETRIES;
        this.storageKey = config.STORAGE_KEY;
        this.state = this.loadState() || this.createInitialState();

        // 多重起動防止フラグ
        this.isProcessing = false;
        this.hasFinalized = false;

        // 🌟 音声確定（finalizeAudio）処理自体の多重実行防止フラグ。
        //   文字起こしの多重実行防止（isProcessing）とは独立させる。
        this.isFinalizingAudio = false;

        // 🌟 追加：音声の追記保存（appendAudioChunk）は失敗しても録音自体は止めない。
        //   ただし失敗した断片は記録しておき、最後に警告できるようにする。
        this.audioAppendFailures = [];
    }

    // --- 部署1: 記憶・進捗管理担当 ---
    createInitialState() {
        return {
            sessionId: Date.now().toString(),
            mode: '3',
            chunks: [],       // 音声保存用チャンクの記録（文字起こしには使わない）
            isCompleted: false,
            // 🌟 追加：この録音セッションの音声が既に1本化・確定済みかどうか。
            //   ページ再読み込みや再開時にも判定できるよう永続化する。
            audioFinalized: false,
            audioUrl: null,
            // 🌟 変更（案A・連番フォルダ保存方式）：
            //   従来は「結合済み単一音声ファイルのID」を保持していたが、
            //   案Aでは音声を結合しないため、代わりに「会議専用フォルダの
            //   ID」を保持する。お助けモード（緊急再開）専用。
            //   通常フローでは使わない。
            audioFolderId: null,
            // 🌟 追加：録音時に使われたmimeType（appendAudioChunk時に記録される）。
            //   finalizeAudio呼び出し時に使う。
            mimeType: null,
            // 🌟 新設（逐次アップロード方式）：
            //   録音中、10分ごとに確定したチャンクをGemini File APIへ
            //   アップロードした結果得られる fileUri を、順番通り配列で
            //   蓄積する。文字起こしは最終的にこの配列をまとめてGASへ
            //   渡すことで行う（重い音声データは二度と送らない）。
            //   localStorageに永続化されるため、アプリが落ちても
            //   このURI配列さえ残っていれば「重い音声の再アップロード」
            //   をスキップして即座に文字起こしから再開できる。
            geminiFileUris: [],
            // 🌟 新設：Geminiアップロードに失敗したチャンクの記録。
            //   Drive保存（appendAudioChunk）と異なり、こちらが失敗すると
            //   最終的な文字起こしにそのチャンクの内容が含まれなくなる
            //   ため、録音終了時にユーザーへ明示的に警告する。
            geminiUploadFailures: [],
            // 🌟 新設（優先度A・③：チャンク欠番検知）：
            //   このセッションで実際に発行された（＝フロント側で
            //   セグメントとして確定した）チャンクの総数。
            //   0始まりのchunkIndexが 0, 1, 2, ... expectedChunkCount-1
            //   まで存在するはず、という期待値として使う。
            //   appendAudioChunk / uploadChunkToGeminiAndStore の
            //   どちらか（先に呼ばれた方）が更新する。
            expectedChunkCount: 0
        };
    }

    saveState() { 
        const cleanChunks = this.state.chunks.map(chunk => {
            const { base64Data, ...rest } = chunk; // 容量オーバー回避のため音声データは除外
            return rest;
        });
        
        const stateCopy = {
            ...this.state,
            chunks: cleanChunks
        };
        
        localStorage.setItem(this.storageKey, JSON.stringify(stateCopy)); 
    }

    loadState() {
        const saved = localStorage.getItem(this.storageKey);
        return saved ? JSON.parse(saved) : null;
    }
    
    clearState() {
        localStorage.removeItem(this.storageKey);
        this.state = this.createInitialState();
        this.hasFinalized = false;
        this.audioAppendFailures = [];
    }

    // 🌟 追加：新しい録音セッションを開始する際に呼ぶ（sessionIdを確定させる）
    startNewSession() {
        this.state = this.createInitialState();
        this.hasFinalized = false;
        this.isProcessing = false;
        this.isFinalizingAudio = false;
        this.audioAppendFailures = [];
        this.saveState();
        return this.state.sessionId;
    }

    // --- 部署2: 文字起こし用チャンクの記録担当 ---
    // ⚠️ 非推奨（バグ修正・方式変更）：
    //   この関数は、録音中の個別チャンクを文字起こし用に記録する目的で
    //   使われていたが、ヘッダーなしチャンクの単体文字起こしが誤った
    //   結果を生む不具合の原因だったため、通常フローからは呼び出さない
    //   方針に変更した（HTML側のhandleDataAvailableから呼び出しを削除済み）。
    //   後方互換のため関数自体は残している。
    addTranscribeChunk(base64Data, index, mimeType, meetingName) {
        if (this.hasFinalized) {
            console.warn(`⚠️ addTranscribeChunk: セッション確定後のチャンク(${index})を検知、破棄します。`);
            return;
        }

        this.state.chunks.push({
            id: index,
            base64Data: base64Data, 
            mimeType: mimeType || 'audio/webm',
            meetingName: meetingName || "無題の会議",
            status: 'pending',
            text: '',
            retryCount: 0
        });
        this.saveState();
    }

    // --- 部署2': 音声本体の保存担当（Drive永続バックアップ用） ---
    // 🛠 2時間超対応版：10分ごとに「完全停止→即再開」で確定した、
    //   ヘッダー付きの完全な1本のWebMファイルを、そのままGASへ送信する。
    //   各チャンクはGAS側で個別ファイルとして保存され、録音終了時に
    //   一括結合される（人間が後で聞き直すための永続バックアップが目的）。
    async appendAudioChunk(base64Data, mimeType, meetingName, chunkIndex) {
        // 🌟 音声結合時（finalizeAudio）に必要になるmimeTypeを、
        //   ここでstateに記録しておく（従来はchunks配列から拾っていたが、
        //   chunks配列は文字起こし用の役割を持たなくなったため）。
        if (!this.state.mimeType) {
            this.state.mimeType = mimeType || 'audio/webm';
        }

        // 🌟 新設（優先度A・③：チャンク欠番検知）：
        //   このセッションで発行されたチャンクの最大個数を更新する。
        //   chunkIndexは0始まりのため、個数としては+1する。
        if (chunkIndex + 1 > this.state.expectedChunkCount) {
            this.state.expectedChunkCount = chunkIndex + 1;
            this.saveState();
        }

        const payload = {
            action: "appendAudioChunk",
            sessionId: this.state.sessionId,
            audioData: base64Data,
            mimeType: mimeType || 'audio/webm',
            meetingName: meetingName || "無題の会議",
            chunkIndex: chunkIndex
        };

        // 🌟 音声保存はリトライしつつ行うが、失敗しても録音継続は妨げない
        //   （文字起こしと違い、ここで例外を投げるとユーザーの録音操作自体が壊れるため）
        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const waitTime = Math.pow(2, attempt) * 1000;
                    console.warn(`⚠️ 音声チャンク保存: ${waitTime / 1000}秒待機して再送します...`);
                    await new Promise(res => setTimeout(res, waitTime));
                }
                await this.callGasApi(payload);
                return true;
            } catch (error) {
                lastError = error;
                console.error(`❌ 音声チャンク保存エラー (${attempt + 1}回目)`, error);
            }
        }

        // 🌟 全リトライ失敗 → 記録だけ残し、ユーザーには最終的に警告する
        this.audioAppendFailures.push({ chunkIndex, error: lastError ? lastError.message : "unknown" });
        return false;
    }

    // ==========================================
    // 🌟 新設（2時間超対応・逐次アップロード方式）：
    //   10分ごとに確定したチャンクを、その都度Gemini File APIへ
    //   アップロードする。返ってきたfileUriは、正しい順序（chunkIndex順）
    //   でstate.geminiFileUrisに記録し、localStorageへ永続化する。
    //
    // 🛡️ 順序の保証：
    //   appendAudioChunk（Drive保存）と同様、非同期処理が複数同時に
    //   走ってもURIの並び順が崩れないよう、chunkIndexをキーにした
    //   オブジェクトへ一旦格納し、最終的に読み出す際にindexでソートする。
    //   （呼び出し元でキューによる直列化も行っているため、通常は
    //    順不同で完了することはないが、二重の安全策として順序保証を持たせる）
    //
    // ⚠️ 失敗時の扱い：
    //   Drive保存と違い、こちらが失敗すると「そのチャンクの内容が
    //   最終的な文字起こしに含まれない」という直接的な影響がある。
    //   そのため、失敗はgeminiUploadFailuresに記録し、録音終了時に
    //   ユーザーへ明示的に警告する（Drive上の音声原本は別途残っている
    //   ため、内容自体が完全に失われるわけではない）。
    // ==========================================
    async uploadChunkToGeminiAndStore(base64Data, mimeType, chunkIndex) {
        // 🌟 新設（優先度A・③：チャンク欠番検知）：
        //   appendAudioChunkと同様、こちらでも念のため更新しておく
        //   （どちらが先に呼ばれても正しく最大値が記録されるように、
        //   Math.maxで安全に比較する）。
        if (chunkIndex + 1 > this.state.expectedChunkCount) {
            this.state.expectedChunkCount = chunkIndex + 1;
            this.saveState();
        }

        const payload = {
            action: "uploadChunkToGemini",
            audioData: base64Data,
            mimeType: mimeType || 'audio/webm',
            chunkIndex: chunkIndex
        };

        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const waitTime = Math.pow(2, attempt) * 1000;
                    console.warn(`⚠️ Geminiアップロード: ${waitTime / 1000}秒待機して再送します...（チャンク${chunkIndex}）`);
                    await new Promise(res => setTimeout(res, waitTime));
                }
                const response = await this.callGasApi(payload);

                // 🌟 chunkIndexをキーとして記録することで、非同期完了順序が
                //   前後しても、最終的に正しい時系列順に並べ直せるようにする。
                this.state.geminiFileUris.push({
                    chunkIndex: chunkIndex,
                    fileUri: response.fileUri
                });
                this.saveState();

                console.log(`✅ Geminiアップロード完了（チャンク${chunkIndex}）: fileUri=${response.fileUri}`);
                return true;

            } catch (error) {
                lastError = error;
                console.error(`❌ Geminiアップロードエラー (${attempt + 1}回目、チャンク${chunkIndex})`, error);
            }
        }

        // 🌟 全リトライ失敗 → 記録だけ残し、ユーザーには最終的に警告する
        this.state.geminiUploadFailures.push({ chunkIndex, error: lastError ? lastError.message : "unknown" });
        this.saveState();
        console.error(`❌ チャンク${chunkIndex}のGeminiアップロードが最終的に失敗しました。このチャンクの内容は文字起こしに含まれません。`);
        return false;
    }

    // ==========================================
    // 🌟 新設：音声結合を単独で最優先に確定させる処理（音声優先確定対応）
    //
    // 🛠 呼び出しタイミング：
    //   録音停止直後、文字起こし処理（processAllChunks）を始める「前」に
    //   フロント側（recorder-controller.html側）から必ず呼ぶこと。
    //
    // 🛡️ 冪等性・リトライ：
    //   ・音声結合はGAS側で「一時チャンクを消費して1本化する」破壊的な処理のため、
    //     多重実行防止フラグ(isFinalizingAudio)を設ける。
    //   ・既に確定済み(audioFinalized=true)の場合は何もせず即座に成功を返す
    //     （再開時・多重呼び出し時に不要な通信をしないため）。
    //   ・通信エラー時は、文字起こしより優先度が高い処理のため、
    //     appendAudioChunkよりやや粘り強めにリトライする。
    //   ・それでも失敗した場合は例外を投げ、呼び出し元（UI側）に
    //     「音声すら確定できなかった」ことを明確に伝える
    //     （この場合はユーザーに録音データの手動確認を促す必要があるため、
    //      黙って握りつぶさない）。
    // ==========================================
    async finalizeAudioAndGetResult(meetingName) {
        // 既に確定済みなら何もしない（冪等）
        if (this.state.audioFinalized) {
            console.log("ℹ️ finalizeAudioAndGetResult: この録音は既に音声確定済みです。スキップします。");
            return {
                audioFinalized: true,
                audioUrl: this.state.audioUrl,
                audioFolderId: this.state.audioFolderId,
                alreadyFinalized: true
            };
        }

        if (this.isFinalizingAudio) {
            console.warn("⚠️ finalizeAudioAndGetResult: 既に音声確定処理が進行中です。");
            return null;
        }
        this.isFinalizingAudio = true;

        const payload = {
            action: "finalizeAudio",
            sessionId: this.state.sessionId,
            meetingName: meetingName || "無題の会議",
            mimeType: this.state.mimeType || 'audio/webm'
        };

        // 🌟 音声確定は最優先事項のため、appendAudioChunkよりリトライ回数を増やす
        const audioFinalizeMaxRetries = this.maxRetries + 2;
        let lastError = null;

        try {
            for (let attempt = 0; attempt <= audioFinalizeMaxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        const waitTime = Math.pow(2, attempt) * 1000;
                        console.warn(`⚠️ 音声確定処理: ${waitTime / 1000}秒待機して再試行します... (${attempt}回目)`);
                        await new Promise(res => setTimeout(res, waitTime));
                    }

                    const response = await this.callGasApi(payload);

                    // 🌟 変更（案A対応）：案Aでは音声結合を行わないため、
                    //   GAS側の処理は「専用フォルダの存在・状態確認」のみとなる。
                    //   これは録音中のappendAudioChunkの時点で実質的に既に
                    //   完了している処理のため、通信さえ成功すればほぼ確実に成功する。
                    this.state.audioFinalized = true;
                    this.state.audioUrl = response.audioUrl || null;
                    this.state.audioFolderId = response.audioFolderId || null;
                    this.saveState();

                    console.log("✅ 音声データの確認が完了しました（案A：連番フォルダ保存）。", response);

                    return {
                        audioFinalized: response.audioFinalized !== false,
                        audioUrl: response.audioUrl || null,
                        audioFolderId: response.audioFolderId || null,
                        fileCount: response.fileCount,
                        alreadyFinalized: !!response.alreadyFinalized
                    };

                } catch (error) {
                    lastError = error;
                    console.error(`❌ 音声確定処理エラー (${attempt + 1}回目)`, error);
                }
            }

            // 🌟 リトライを尽くしても失敗 → ここは黙って握りつぶさず例外を投げる。
            //   音声さえ確定できれば他の方法で議事録化できる、という運用方針の
            //   前提が崩れるケースのため、ユーザーに明確に知らせる必要がある。
            throw new Error(
                "音声データの確認に失敗しました。録音の各セグメントはGoogleドライブの" +
                "「レコーダー/音声データ」フォルダ内の、会議名のついた専用フォルダに" +
                "個別に残っている可能性があります。手動での確認をお願いします。詳細: " +
                (lastError ? lastError.message : "不明なエラー")
            );

        } finally {
            this.isFinalizingAudio = false;
        }
    }

    // ==========================================
    // ⚠️ 非推奨（2時間超対応・逐次アップロード方式への移行に伴う変更）：
    //   この関数は、「専用フォルダ内の全ファイルをその場でGeminiへ
    //   アップロードし直してから文字起こしする」緊急経路として使う。
    //   「お助けモード」で、録音中に逐次アップロード済みのfileUriが
    //   localStorageから失われている（別端末・別ブラウザからの再開等）
    //   場合に、Drive上の専用フォルダから作り直す。
    //
    // ⚠️ 注意点：
    //   専用フォルダ内の全ファイルをその場でアップロードし直すため、
    //   通常フロー（録音中の逐次アップロード）に比べて、この経路は
    //   GASの6分実行時間制限に近づくリスクがある（ファイル数が多いほど
    //   顕著）。そのため、この関数は「通常運用の主経路」ではなく、
    //   あくまで緊急の再開手段として位置づける。
    // ==========================================
    async transcribeFinalizedAudio(meetingName, templateType) {
        if (this.isProcessing) {
            console.warn("⚠️ transcribeFinalizedAudio: 既に処理中のため、この呼び出しは無視します。");
            return null;
        }
        if (this.hasFinalized) {
            console.warn("⚠️ transcribeFinalizedAudio: このセッションは既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        if (!this.state.audioFolderId) {
            throw new Error(
                "音声の専用フォルダがまだ確認できていません。先に音声データの確認を完了させてください。"
            );
        }

        this.isProcessing = true;

        try {
            console.log("🚀 専用フォルダ内の音声ファイルからの文字起こしを開始します...", "audioFolderId:", this.state.audioFolderId);

            const payload = {
                action: "transcribeFromAudioFile",
                audioFolderId: this.state.audioFolderId,
                mimeType: this.state.mimeType || 'audio/webm'
            };

            // 🌟 音声全体を1回で処理するため、通信断・タイムアウト対策として
            //   ある程度粘り強くリトライする。
            let lastError = null;
            let response = null;
            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        const waitTime = Math.pow(2, attempt) * 1000;
                        console.warn(`⚠️ 文字起こし処理: ${waitTime / 1000}秒待機して再試行します... (${attempt}回目)`);
                        await new Promise(res => setTimeout(res, waitTime));
                    }
                    response = await this.callGasApi(payload);
                    break;
                } catch (error) {
                    lastError = error;
                    console.error(`❌ 文字起こし処理エラー (${attempt + 1}回目)`, error);
                }
            }

            if (!response) {
                throw new Error(
                    "文字起こし処理に失敗しました。音声データ自体は専用フォルダに保存済みのため失われていません。" +
                    "詳細: " + (lastError ? lastError.message : "不明なエラー")
                );
            }

            const fullTranscript = response.text || "";
            console.log("🎉 文字起こしが完了しました！");

            return await this.finalizeSession(meetingName, templateType, fullTranscript);

        } finally {
            this.isProcessing = false;
        }
    }

    // ==========================================
    // 🌟 新設（優先度A・③：チャンク欠番検知）
    //
    // 🛠 目的：
    //   録音中、通信障害等により特定のチャンクだけがGeminiへの
    //   アップロードに失敗すると、そのチャンクの内容は文字起こしに
    //   反映されない。従来はgeminiUploadFailuresへの記録による検知の
    //   みだったが、これは「アップロードのAPI呼び出し自体が失敗した」
    //   ケースしか捉えられない。
    //
    //   万が一、何らかの理由でアップロードのAPI呼び出し自体は成功した
    //   ように見えても、実際にはchunkIndexの記録が欠落する、あるいは
    //   フロント側のイベント発火順序に異常があった場合でも検知できる
    //   よう、「本来 0 〜 expectedChunkCount-1 まで揃っているはずの
    //   連番のうち、実際にgeminiFileUrisに記録されているのはどれか」を
    //   直接突き合わせて欠番を割り出す。
    //
    // 🛡️ 設計方針：
    //   この関数は検知するだけで、自動修復は行わない（欠落した音声
    //   そのものを後から復元する手段がないため）。呼び出し元
    //   （UI側）が、検知結果をもとにユーザーへ警告する。
    // ==========================================
    detectMissingChunks() {
        const expectedCount = this.state.expectedChunkCount || 0;
        if (expectedCount === 0) {
            return [];
        }

        const presentIndexes = new Set(
            (this.state.geminiFileUris || []).map(entry => entry.chunkIndex)
        );

        const missing = [];
        for (let i = 0; i < expectedCount; i++) {
            if (!presentIndexes.has(i)) {
                missing.push(i);
            }
        }
        return missing;
    }

    // ==========================================
    // 🌟 新設（2時間超対応・逐次アップロード方式）：通常フローの主経路
    //
    // 🛠 目的：
    //   録音中、10分ごとに逐次Gemini File APIへアップロードしておいた
    //   fileUriの配列（state.geminiFileUris）を使い、重い音声データを
    //   一切再送信することなく文字起こしを行う。
    //   GASの6分実行時間制限にもBlobサイズ上限にも抵触しないため、
    //   2時間・3時間規模の録音でも安定して動作する。
    //
    // 🛡️ 前提：
    //   この関数を呼ぶ前に、録音中の各チャンクで
    //   uploadChunkToGeminiAndStore() が呼ばれ、
    //   this.state.geminiFileUris に1件以上のfileUriが記録されていること。
    //   （Drive側の音声結合＝finalizeAudioAndGetResult とは完全に独立した
    //    処理のため、両者の呼び出し順序に依存関係はない）
    // ==========================================
    async transcribeFromGeminiFileUris(meetingName, templateType) {
        if (this.isProcessing) {
            console.warn("⚠️ transcribeFromGeminiFileUris: 既に処理中のため、この呼び出しは無視します。");
            return null;
        }
        if (this.hasFinalized) {
            console.warn("⚠️ transcribeFromGeminiFileUris: このセッションは既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        if (!this.state.geminiFileUris || this.state.geminiFileUris.length === 0) {
            throw new Error(
                "文字起こし対象の音声データがGeminiにアップロードされていません。" +
                "録音が正しく行われたかご確認ください。"
            );
        }

        // 🌟 新設（優先度A・③）：欠番があれば、処理を止めずに警告情報として
        //   記録しておく（音声原本はDriveに残っているため、致命的ではない）。
        const missingChunks = this.detectMissingChunks();
        if (missingChunks.length > 0) {
            console.warn(
                `⚠️ チャンク欠番を検知しました: [${missingChunks.join(", ")}]。` +
                `該当区間は文字起こしに反映されません（音声原本はDriveに残っています）。`
            );
        }

        this.isProcessing = true;

        try {
            // 🌟 chunkIndex順にソートしてから、fileUriだけの配列を取り出す。
            //   非同期アップロードの完了順序が前後していても、ここで
            //   必ず正しい時系列順に並べ直される。
            const sortedEntries = [...this.state.geminiFileUris].sort(
                (a, b) => a.chunkIndex - b.chunkIndex
            );
            const orderedFileUris = sortedEntries.map(entry => entry.fileUri);

            console.log(
                "🚀 逐次アップロード済みのfileUri配列から文字起こしを開始します...",
                "件数:", orderedFileUris.length
            );

            const payload = {
                action: "transcribeFromMultipleFiles",
                fileUris: orderedFileUris,
                mimeType: this.state.mimeType || 'audio/webm'
            };

            // 🌟 fileUri参照のみで音声データ自体は送らないため、
            //   通信量は小さいが、Gemini側の処理時間（複数ファイル分の
            //   解析）は長くなり得るため、リトライは粘り強く行う。
            let lastError = null;
            let response = null;
            for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        const waitTime = Math.pow(2, attempt) * 1000;
                        console.warn(`⚠️ 文字起こし処理: ${waitTime / 1000}秒待機して再試行します... (${attempt}回目)`);
                        await new Promise(res => setTimeout(res, waitTime));
                    }
                    response = await this.callGasApi(payload);
                    break;
                } catch (error) {
                    lastError = error;
                    console.error(`❌ 文字起こし処理エラー (${attempt + 1}回目)`, error);
                }
            }

            if (!response) {
                throw new Error(
                    "文字起こし処理に失敗しました。音声データ自体はDriveに確定保存済み（または保存処理中）のため失われていません。" +
                    "詳細: " + (lastError ? lastError.message : "不明なエラー")
                );
            }

            const fullTranscript = response.text || "";
            console.log("🎉 文字起こしが完了しました！");

            return await this.finalizeSession(meetingName, templateType, fullTranscript);

        } finally {
            this.isProcessing = false;
        }
    }

    // --- 部署3: 文字起こしの通信・リトライ担当（非推奨） ---
    // ⚠️ 非推奨（バグ修正・方式変更、および2時間超対応への移行）：
    //   録音中の個別チャンクを並列で文字起こしする従来方式。
    //   ヘッダーなしチャンクの単体文字起こしが誤った結果を生む不具合の
    //   原因だったため、通常フローからは呼び出さない。
    //   後方互換のため関数自体は残している。新方式は
    //   transcribeFromGeminiFileUris を使うこと。
    async processAllChunks(meetingName, templateType, onProgressCallback) {
        if (this.isProcessing) {
            console.warn("⚠️ processAllChunks: 既に処理中のため、この呼び出しは無視します。");
            return null;
        }
        if (this.hasFinalized) {
            console.warn("⚠️ processAllChunks: このセッションは既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        this.isProcessing = true;

        try {
            console.log("🚀 文字起こし処理を開始します...", "chunks数:", this.state.chunks.length);
            const pendingChunks = this.state.chunks.filter(c => c.status !== 'completed');

            pendingChunks.forEach(chunk => {
                if (!chunk.meetingName) chunk.meetingName = meetingName || "無題の会議";
            });

            const promises = pendingChunks.map(chunk => 
                this.sendChunkWithRetry(chunk, onProgressCallback)
            );
            await Promise.all(promises);

            const allCompleted = this.state.chunks.every(c => c.status === 'completed');
            if (allCompleted) {
                console.log("🎉 すべての文字起こしが完了しました！");
                const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
                const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');
                return await this.finalizeSession(meetingName, templateType, fullTranscript);
            } else {
                throw new Error("一部の処理がエラーで停止しました。手動再開をお願いします。");
            }
        } finally {
            this.isProcessing = false;
        }
    }

    // ⚠️ 非推奨（バグ修正・方式変更）：processAllChunks専用の補助関数。詳細は上記コメント参照。
    async sendChunkWithRetry(chunk, onProgressCallback) {
        chunk.status = 'processing';
        this.saveState();
        if(onProgressCallback) onProgressCallback(this.state.chunks);

        while (chunk.retryCount <= this.maxRetries) {
            try {
                const waitTime = chunk.retryCount === 0 ? 0 : Math.pow(2, chunk.retryCount) * 1000;
                if (waitTime > 0) {
                    console.warn(`⚠️ パーツ${chunk.id}: ${waitTime/1000}秒待機して再送します...`);
                    await new Promise(res => setTimeout(res, waitTime));
                }

                const payload = {
                    action: "transcribe",
                    meetingName: chunk.meetingName,
                    chunkId: chunk.id,
                    audioData: chunk.base64Data,
                    mimeType: chunk.mimeType 
                };
                
                const response = await this.callGasApi(payload);
                
                chunk.status = 'completed';
                chunk.text = response.text;
                this.saveState();
                if(onProgressCallback) onProgressCallback(this.state.chunks);
                return true;

            } catch (error) {
                chunk.retryCount++;
                console.error(`❌ パーツ${chunk.id}: エラー (${chunk.retryCount}回目)`, error);
                
                if (chunk.retryCount > this.maxRetries) {
                    chunk.status = 'error';
                    this.saveState();
                    if(onProgressCallback) onProgressCallback(this.state.chunks);
                    return false;
                }
            }
        }
    }

    async callGasApi(payload) {
        if (!this.gasUrl) throw new Error("GASのURLが設定されていません。");
        
        const response = await fetch(this.gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || "GAS側で不明なエラーが発生しました");
        }
        return data.data;
    }

    // ==========================================
    // 🌟 新設：自動再開まわり（お助けモード対応）
    //
    // 🛠 設計方針：
    //   ユーザーにリンクや場所を入力させず、localStorageに残っている
    //   sessionIdだけを使って「今どの段階から再開すべきか」を
    //   サーバー（GAS）側の実データを根拠に判定する。
    //   判定結果（ステータス）はUI側にそのまま伝え、
    //   「音声結合からの再開」なのか「文字起こしからの再開」なのかを
    //   ユーザーに明示できるようにする。
    // ==========================================

    // 🌟 未完了セッションが残っているかどうかを判定する（起動時チェック用）。
    //   正常完了時（finalizeSession成功時）はclearState()でsessionId自体が
    //   リセットされるため、sessionIdが残っている＝何らかの理由で
    //   完了に至らなかったセッション、と判定できる。
    hasPendingSession() {
        return !!(this.state && this.state.sessionId && this.state.chunks);
    }

    // 🌟 新設（2時間超対応・逐次アップロード方式）：
    //   localStorageに、録音中に逐次アップロード済みのfileUriが
    //   1件以上残っているかどうかを判定する。これはサーバーへの問い合わせ
    //   なしで即座に判定できるローカル情報のため、checkSessionStatus
    //   （Drive側の状態を問い合わせる、やや重い処理）より先に確認することで、
    //   「文字起こしからすぐ再開できる」ケースをより高速に案内できる。
    hasPendingGeminiFileUris() {
        return !!(this.state && this.state.geminiFileUris && this.state.geminiFileUris.length > 0);
    }

    // 🌟 現在localStorageに残っているsessionIdについて、サーバー側の
    //   実データを根拠に「今どの段階か」を問い合わせる。
    //   戻り値の status:
    //     "audio_pending"                  … 音声結合がまだ（最優先で再開すべき）
    //     "audio_done_transcript_pending"  … 音声は確定済み、文字起こし以降が必要
    //     "not_found"                      … サーバー側にデータなし（再開不可）
    //
    // ⚠️ 注意（2時間超対応版）：この判定はDrive上の「音声原本」の状態のみを
    //   見ており、Gemini側にアップロード済みのfileUri（文字起こし用）の
    //   有無とは独立している。お助けモードのUI側では、まず
    //   hasPendingGeminiFileUris() を優先的に確認し、fileUriが残っていれば
    //   Drive側の状態に関わらず「文字起こしから再開」を案内する設計とする。
    async checkSessionStatus() {
        if (!this.state.sessionId) {
            return { status: "not_found" };
        }
        const payload = {
            action: "checkSessionStatus",
            sessionId: this.state.sessionId
        };
        return await this.callGasApi(payload);
    }

    // 🌟 「状態A：音声結合が未完了」からの再開。
    //   実体はfinalizeAudioAndGetResult()と同じだが、お助けモードからの
    //   明示的な再開であることが分かるよう、専用の入り口を用意している。
    async resumeFromAudioPending(meetingName) {
        console.log("🛠 お助けモード：音声結合の再開を試みます。sessionId=", this.state.sessionId);
        return await this.finalizeAudioAndGetResult(meetingName);
    }

    // 🌟 「状態B：音声は確認済みだが、文字起こし・議事録が未完了」からの再開。
    //   localStorageにfileUri配列が残っていない（別端末・別ブラウザからの
    //   再開等）場合に、Drive上の専用フォルダ内の全ファイルを丸ごと
    //   Geminiに渡して文字起こしをやり直す。
    //
    // 🛠 設計メモ：処理内容はtranscribeFinalizedAudio()と似ているが、
    //   お助けモードからの再開はセッション状態（isProcessing/hasFinalized等の
    //   インメモリフラグ）が失われている可能性がある前提のため、あえて
    //   finalizeSession()を経由せず、この関数内で完結させている。
    async resumeFromTranscriptPending(audioFolderId, mimeType, meetingName, templateType) {
        console.log("🛠 お助けモード：専用フォルダ内の音声ファイルからの文字起こし再開を試みます。audioFolderId=", audioFolderId);

        const payload = {
            action: "transcribeFromAudioFile",
            audioFolderId: audioFolderId,
            mimeType: mimeType || 'audio/webm'
        };

        const response = await this.callGasApi(payload);
        const fullTranscript = response.text || "";

        // 🌟 議事録生成まで含めて一気に確定させる
        const minutesPayload = {
            action: "generateMinutes",
            text: fullTranscript,
            meetingName: meetingName || "無題の会議",
            templateType: templateType || "汎用議事録",
            mode: this.state.mode || "3"
        };

        const minutesResponse = await this.callGasApi(minutesPayload);

        // 🌟 再開完了後は、このセッションの役目は終わりなのでクリアする
        this.clearState();

        return {
            transcript: fullTranscript,
            documentUrl: minutesResponse.documentUrl,
            transcriptUrl: minutesResponse.transcriptUrl
        };
    }

    // --- 部署4: 最終確定担当（音声優先確定対応・簡素化） ---
    // 🌟 変更点：音声結合はfinalizeAudioAndGetResult()が既に録音停止直後に
    //   単独で完了させている前提のため、ここでは文字起こし・議事録の保存のみ行う。
    // 🌟 変更点（バグ修正・方式変更）：fullTranscriptを引数として受け取るように
    //   変更した（以前はthis.state.chunksから自前で組み立てていたが、
    //   チャンク単位の文字起こしを廃止したため、呼び出し元から渡してもらう）。
    async finalizeSession(meetingName, templateType, fullTranscript) {
        if (this.hasFinalized) {
            console.warn("⚠️ finalizeSession: 既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        this.hasFinalized = true;

        console.log("🔗 文字起こしの結合と最終確定を開始します...", new Date().toISOString());

        let resultData = {
            transcript: fullTranscript,
            documentUrl: null,
            transcriptUrl: null,
            // 🌟 音声確定は既に完了している前提のため、stateの値をそのまま返却情報に含める
            audioFinalized: this.state.audioFinalized,
            audioUrl: this.state.audioUrl
        };

        const payload = {
            action: "generateMinutes",
            text: fullTranscript,
            meetingName: meetingName || "無題の会議",
            templateType: templateType || "汎用議事録",
            mode: this.state.mode
        };

        try {
            const response = await this.callGasApi(payload);
            resultData.documentUrl = response.documentUrl;
            resultData.transcriptUrl = response.transcriptUrl;
            console.log("✅ 最終処理完了: ", response);

            if (this.audioAppendFailures.length > 0) {
                console.warn("⚠️ 録音中に一部の音声追記保存が失敗していました。音声に欠損がある可能性があります。", this.audioAppendFailures);
                resultData.audioWarning = true;
            }

            // 🌟 新設（2時間超対応・逐次アップロード方式、および優先度A・③：
            //   チャンク欠番検知）：
            //   Geminiアップロードに失敗したチャンクがあった場合、
            //   そのチャンクの発言内容は文字起こしに含まれていない
            //   （Drive上の音声原本には残っているため、内容が完全に
            //   失われるわけではないが、議事録には反映されていない）。
            //   このことをユーザーに明示的に警告する。
            //
            //   欠番の情報源は2つある：
            //   ① geminiUploadFailures … アップロードのAPI呼び出し自体が
            //      明示的に失敗として記録されたケース
            //   ② detectMissingChunks() … 期待されるチャンク総数
            //      （expectedChunkCount）と、実際にgeminiFileUrisに
            //      記録されている件数を直接突き合わせて検知するケース
            //      （①では捉えられない、記録漏れ等の異常も検知できる）
            //   両方を統合し、重複のない欠番リストとしてユーザーに示す。
            const failureIndexes = (this.state.geminiUploadFailures || []).map(f => f.chunkIndex);
            const detectedMissing = this.detectMissingChunks();
            const missingChunkIndexes = [...new Set([...failureIndexes, ...detectedMissing])].sort((a, b) => a - b);

            if (missingChunkIndexes.length > 0) {
                console.warn(
                    "⚠️ 録音中に一部のチャンクが欠落していました。" +
                    "該当区間の内容は文字起こし・議事録に反映されていません。",
                    missingChunkIndexes
                );
                resultData.transcriptionWarning = true;
                resultData.missingChunkIndexes = missingChunkIndexes;
            }

            this.clearState();
            return resultData;
        } catch (err) {
            console.error("❌ 最終確定処理でエラー発生。再試行できるようフラグを戻します。", err);
            this.hasFinalized = false;
            throw err;
        }
    }
}

// 🚀 現場監督の出勤
window.appController = new RecorderController(CONFIG);

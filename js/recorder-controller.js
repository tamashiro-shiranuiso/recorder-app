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
 * ・対策として、文字起こしは「録音停止後に音声結合（finalizeAudio）で
 *   確定した、1本の正しいWebMファイル」に対して行う方式に統一した。
 *   これにより、音声保存側（appendAudioChunk）と文字起こし側の設計が
 *   矛盾なく揃った。
 * ・addTranscribeChunk / processAllChunks / sendChunkWithRetry は、
 *   後方互換のためコードとしては残しているが、通常フローからは
 *   呼び出さない（呼び出し箇所はHTML側から削除済み）。
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
            // 🌟 追加：確定済み音声ファイルのDriveファイルID。
            //   文字起こしは、チャンク単位ではなくこのファイルIDを使って
            //   1本のファイルに対して行う（バグ修正・方式変更）。
            audioFileId: null,
            // 🌟 追加：録音時に使われたmimeType（appendAudioChunk時に記録される）。
            //   finalizeAudio呼び出し時に使う。
            mimeType: null
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

    // --- 部署2': 音声本体の保存担当（設計変更版） ---
    // timeslice方式で録音中に定期的に出てくる音声断片を、GASへ独立したチャンクとして送信する。
    // 各チャンクはGAS側で個別ファイルとして保存され、最後に一括結合される
    // （追記方式ではないため、送信順序を厳密に守る必要は結合時のソートで担保されるが、
    //   chunkIndexの採番自体は呼び出し側で順番通りに行うこと）。
    async appendAudioChunk(base64Data, mimeType, meetingName, chunkIndex) {
        // 🌟 音声結合時（finalizeAudio）に必要になるmimeTypeを、
        //   ここでstateに記録しておく（従来はchunks配列から拾っていたが、
        //   chunks配列は文字起こし用の役割を持たなくなったため）。
        if (!this.state.mimeType) {
            this.state.mimeType = mimeType || 'audio/webm';
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
                audioFileId: this.state.audioFileId,
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

                    // 🌟 GAS側が「対象チャンクなし＝既に確定済みの可能性」と
                    //   返してきた場合も、成功扱いとして進める
                    //   （厳密にはチャンク未保存の異常系の可能性もあるが、
                    //    音声保存自体はappendAudioChunk側で別途警告済みのため、
                    //    ここで処理を止めずに先に進める）。
                    this.state.audioFinalized = true;
                    this.state.audioUrl = response.audioUrl || null;
                    this.state.audioFileId = response.audioFileId || null;
                    this.saveState();

                    console.log("✅ 音声の確定保存が完了しました。", response);

                    return {
                        audioFinalized: response.audioFinalized !== false,
                        audioUrl: response.audioUrl || null,
                        audioFileId: response.audioFileId || null,
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
                "音声の確定保存に失敗しました。録音データはGoogleドライブの「_一時録音中」フォルダに" +
                "チャンクとして残っている可能性があります。手動での確認をお願いします。詳細: " +
                (lastError ? lastError.message : "不明なエラー")
            );

        } finally {
            this.isFinalizingAudio = false;
        }
    }

    // ==========================================
    // 🌟 新設（バグ修正・方式変更）：確定済み音声ファイルを使った文字起こし
    //
    // 🛠 目的：
    //   録音中に生成される個別チャンクを単体で文字起こしに使うと、
    //   ヘッダーなしチャンクをGeminiが誤って解釈し、「同一発言の重複」
    //   「文脈の破綻」といった不具合を引き起こすことが確認された。
    //   対策として、文字起こしは必ず「音声結合（finalizeAudio）で確定
    //   した、1本の正しいWebMファイル」に対して行う。
    //
    // 🛡️ 前提：
    //   この関数を呼ぶ前に、必ず finalizeAudioAndGetResult() が成功し、
    //   this.state.audioFileId が設定されていること
    //   （stopRecordingAndProcess側の呼び出し順序で保証する）。
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
        if (!this.state.audioFileId) {
            throw new Error(
                "音声ファイルがまだ確定していません。先に音声の確定保存を完了させてください。"
            );
        }

        this.isProcessing = true;

        try {
            console.log("🚀 確定済み音声ファイルからの文字起こしを開始します...", "audioFileId:", this.state.audioFileId);

            const payload = {
                action: "transcribeFromAudioFile",
                audioFileId: this.state.audioFileId,
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
                    "文字起こし処理に失敗しました。音声データ自体は確定保存済みのため失われていません。" +
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
    // ⚠️ 非推奨（バグ修正・方式変更）：
    //   録音中の個別チャンクを並列で文字起こしする従来方式。
    //   ヘッダーなしチャンクの単体文字起こしが誤った結果を生む不具合の
    //   原因だったため、通常フローからは呼び出さない。
    //   後方互換のため関数自体は残している。新方式は transcribeFinalizedAudio を使うこと。
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

    // 🌟 現在localStorageに残っているsessionIdについて、サーバー側の
    //   実データを根拠に「今どの段階か」を問い合わせる。
    //   戻り値の status:
    //     "audio_pending"                  … 音声結合がまだ（最優先で再開すべき）
    //     "audio_done_transcript_pending"  … 音声は確定済み、文字起こし以降が必要
    //     "not_found"                      … サーバー側にデータなし（再開不可）
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

    // 🌟 「状態B：音声は確定済みだが、文字起こし・議事録が未完了」からの再開。
    //   チャンク単位のデータはlocalStorageに残っていない（またはbase64を
    //   保持していない）前提のため、確定済みの音声ファイルを丸ごと
    //   Geminiに渡して文字起こしをやり直す。
    //
    // 🛠 設計メモ：処理内容はtranscribeFinalizedAudio()と似ているが、
    //   お助けモードからの再開はセッション状態（isProcessing/hasFinalized等の
    //   インメモリフラグ）が失われている可能性がある前提のため、あえて
    //   finalizeSession()を経由せず、この関数内で完結させている。
    async resumeFromTranscriptPending(audioFileId, mimeType, meetingName, templateType) {
        console.log("🛠 お助けモード：確定済み音声ファイルからの文字起こし再開を試みます。audioFileId=", audioFileId);

        const payload = {
            action: "transcribeFromAudioFile",
            audioFileId: audioFileId,
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

/**
 * レコーザーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終確定
 *
 * 🛠 方式B対応版：
 * ・音声本体は録音中に GAS へ随時「追記保存（appendAudioChunk）」される前提に変更。
 *   そのため停止時に巨大な音声Blobをまるごと送る必要がなくなった。
 * ・文字起こし用のチャンクは従来通り transcribe アクションで個別に送信する。
 * ・addTranscribeChunk / appendAudioChunk のように役割を分離した。
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

        // 🌟 追加：音声の追記保存（appendAudioChunk）は失敗しても録音自体は止めない。
        //   ただし失敗した断片は記録しておき、最後に警告できるようにする。
        this.audioAppendFailures = [];
    }

    // --- 部署1: 記憶・進捗管理担当 ---
    createInitialState() {
        return {
            sessionId: Date.now().toString(),
            mode: '3',
            chunks: [],       // 文字起こし用チャンク
            isCompleted: false
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
        this.audioAppendFailures = [];
        this.saveState();
        return this.state.sessionId;
    }

    // --- 部署2: 文字起こし用チャンクの記録担当 ---
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

    // --- 部署3: 文字起こしの通信・リトライ担当 ---
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
                return await this.finalizeSession(meetingName, templateType);
            } else {
                throw new Error("一部の処理がエラーで停止しました。手動再開をお願いします。");
            }
        } finally {
            this.isProcessing = false;
        }
    }

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

    // --- 部署4: 最終確定担当（方式B・簡素化） ---
    // 🌟 音声本体は既に録音中にGAS側の一時ファイルへ保存済みのため、
    //   ここでは「一時ファイルを正式なファイルとして確定させる」指示を送るだけでよい。
    //   巨大な音声データを再送信する必要がない。
    async finalizeSession(meetingName, templateType) {
        if (this.hasFinalized) {
            console.warn("⚠️ finalizeSession: 既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        this.hasFinalized = true;

        console.log("🔗 文字起こしの結合と最終確定を開始します...", new Date().toISOString());
        const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
        const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');

        let resultData = { transcript: fullTranscript, documentUrl: null, transcriptUrl: null };

        const payload = {
            action: "generateMinutes",
            text: fullTranscript,
            meetingName: meetingName || "無題の会議",
            templateType: templateType || "汎用議事録",
            mode: this.state.mode,
            sessionId: this.state.sessionId, // 🌟 一時ファイルを特定するためのキー
            mimeType: sortedChunks[0]?.mimeType || 'audio/webm'
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

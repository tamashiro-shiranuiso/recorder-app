/**
 * レコーザーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終結合
 *
 * 🛠 修正版：processAllChunks / mergeAndCreateMinutes の多重起動防止ガードを追加
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

        // 🌟 追加：多重起動防止フラグ
        this.isProcessing = false;
        this.hasFinalized = false; // このセッションで最終結合が完了済みかどうか
    }

    // --- 部署1: 記憶・進捗管理担当 ---
    createInitialState() {
        return {
            sessionId: Date.now().toString(),
            mode: '3',
            chunks: [],
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
    }

    // --- 部署2: 録音・スライス担当 ---
    addAudioChunk(base64Data, index, mimeType, meetingName) {
        // 🌟 追加：最終処理が既に完了/実行中のセッションに対する追加チャンクは無視する
        // （onstopの発火遅延で、確定後に紛れ込んでくるケースの保険）
        if (this.hasFinalized) {
            console.warn(`⚠️ addAudioChunk: セッション確定後のチャンク(${index})を検知、破棄します。`);
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

    // --- 部署3: 通信・リトライ担当 ---
    async processAllChunks(meetingName, templateType, fullAudioBase64, onProgressCallback) {
        // 🌟 追加：多重起動ガード（同一セッションで二度と処理させない）
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
            console.log("🚀 並列処理を開始します...", "chunks数:", this.state.chunks.length);
            const pendingChunks = this.state.chunks.filter(c => c.status !== 'completed');

            pendingChunks.forEach(chunk => {
                if (!chunk.meetingName) chunk.meetingName = meetingName || "無題の会議";
            });

            // 🌟 途中パーツの送信（GAS側ではこの段階では保存せず、AI文字起こしだけ行います）
            const promises = pendingChunks.map(chunk => 
                this.sendChunkWithRetry(chunk, onProgressCallback)
            );
            await Promise.all(promises);

            const allCompleted = this.state.chunks.every(c => c.status === 'completed');
            if (allCompleted) {
                console.log("🎉 すべての文字起こしが完了しました！");
                // 🌟 最終結合処理へ全体音声データを引き渡す
                return await this.mergeAndCreateMinutes(meetingName, templateType, fullAudioBase64);
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

    // --- 部署4: 結合・総仕上げ担当 ---
    async mergeAndCreateMinutes(meetingName, templateType, fullAudioBase64) {
        // 🌟 追加：最終結合が既に実行済みなら二度と実行しない
        if (this.hasFinalized) {
            console.warn("⚠️ mergeAndCreateMinutes: 既に確定済みのため、この呼び出しは無視します。");
            return null;
        }
        this.hasFinalized = true; // 🌟 GAS呼び出し前に確定フラグを立てる（await中の再入も防ぐ）

        console.log("🔗 テキストの結合を開始します...", new Date().toISOString());
        const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
        const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');

        let resultData = { transcript: fullTranscript, documentUrl: null, transcriptUrl: null };

        // 🌟 モードに関わらず、最終音声ファイルの保存やドキュメント保存のために必ずGASを呼び出す
        console.log("📝 最終処理をGASへ送信します...");
        
        const payload = {
            action: "generateMinutes",
            text: fullTranscript,
            meetingName: meetingName || "無題の会議",
            templateType: templateType || "汎用議事録",
            mode: this.state.mode,
            fullAudio: fullAudioBase64, // 🌟 統合された全体音声データをGASに届ける
            mimeType: sortedChunks[0]?.mimeType || 'audio/webm'
        };

        try {
            const response = await this.callGasApi(payload);
            resultData.documentUrl = response.documentUrl;
            resultData.transcriptUrl = response.transcriptUrl;
            console.log("✅ 最終処理完了: ", response);

            this.clearState();
            return resultData;
        } catch (err) {
            // 🌟 GAS呼び出しが失敗した場合、hasFinalizedを戻して手動再開を可能にする
            console.error("❌ 最終処理でエラー発生。再試行できるようフラグを戻します。", err);
            this.hasFinalized = false;
            throw err;
        }
    }
}

// 🚀 現場監督の出勤
window.appController = new RecorderController(CONFIG);

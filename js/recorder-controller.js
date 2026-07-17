/**
 * レコーダーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終結合
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
            const { base64Data, ...rest } = chunk; // 容量オーバー回避のため音声データ除外
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
    }

    // --- 部署2: 録音・スライス担当 ---
    addAudioChunk(base64Data, index, mimeType, meetingName) {
        this.state.chunks.push({
            id: index,
            base64Data: base64Data, 
            mimeType: mimeType || 'audio/webm',
            meetingName: meetingName || "無題の会議", // 🌟 会議名をパーツにも保存
            status: 'pending',
            text: '',
            retryCount: 0
        });
        this.saveState();
    }

    // --- 部署3: 通信・リトライ担当 ---
    async processAllChunks(meetingName, templateType, onProgressCallback) {
        console.log("🚀 並列処理を開始します...");
        const pendingChunks = this.state.chunks.filter(c => c.status !== 'completed');

        // 各チャンクへ会議名を強制設定（保険）
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
            return await this.mergeAndCreateMinutes(meetingName, templateType);
        } else {
            throw new Error("一部の処理がエラーで停止しました。手動再開をお願いします。");
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

                // GASへ送信（会議名とパーツIDも伝達）
                const payload = {
                    action: "transcribe",
                    meetingName: chunk.meetingName,
                    chunkId: chunk.id, // 🌟 GAS側で「音声データ_PartX」と命名するために渡す
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
    async mergeAndCreateMinutes(meetingName, templateType) {
        console.log("🔗 テキストの結合を開始します...");
        const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
        const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');

        let resultData = { transcript: fullTranscript, documentUrl: null, transcriptUrl: null };

        // 🌟 改良：モード②（文字起こしのみ保存）と モード③（議事録まで）の両方でGASへデータ保存
        if (this.state.mode === '2' || this.state.mode === '3') {
            console.log("📝 最終処理をGASへ送信します...");
            
            const payload = {
                action: "generateMinutes",
                text: fullTranscript,
                meetingName: meetingName || "無題の会議",
                templateType: templateType || "汎用議事録",
                mode: this.state.mode // 🌟 現在のモードをGASに伝達
            };

            const response = await this.callGasApi(payload);
            resultData.documentUrl = response.documentUrl; // 議事録URL (モード③のみ)
            resultData.transcriptUrl = response.transcriptUrl; // 文字起こしURL (モード②、③共通)
            console.log("✅ 処理完了: ", response);
        }

        this.clearState();
        return resultData;
    }
}

// 🚀 現場監督の出勤
window.appController = new RecorderController(CONFIG);

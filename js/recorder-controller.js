/**
 * レコーダーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終結合
 */

// ==========================================
// 🔧 設定エリア（変更しやすいように一番上に配置）
// ==========================================
const CONFIG = {
    GAS_URL: "https://script.google.com/macros/s/AKfycbyiV6giy9f3ixmVSU3sGmyDpxGVjecUtxvbtbtAye2mvfvBxcZ9pY7aIQ-QxWIPB8TA/exec",
    MAX_RETRIES: 3,
    STORAGE_KEY: "recorder_app_state"
};

// ==========================================
// 🏗 現場監督の設計図（クラス）
// ==========================================
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
    saveState() { localStorage.setItem(this.storageKey, JSON.stringify(this.state)); }
    loadState() {
        const saved = localStorage.getItem(this.storageKey);
        return saved ? JSON.parse(saved) : null;
    }
    clearState() {
        localStorage.removeItem(this.storageKey);
        this.state = this.createInitialState();
    }

    // --- 部署2: 録音・スライス担当 ---
    // ※今回はbase64データを受け取る想定にしています
    addAudioChunk(base64Data, index) {
        this.state.chunks.push({
            id: index,
            base64Data: base64Data, 
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

        // 一斉送信（並列処理）
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

                // 🔴 GASへ本物のデータ送信（文字起こし依頼）
                const payload = {
                    action: "transcribe",
                    fileName: `chunk_${this.state.sessionId}_${chunk.id}`,
                    audioData: chunk.base64Data
                };
                
                const response = await this.callGasApi(payload);
                
                chunk.status = 'completed';
                chunk.text = response.text; // GASから返ってきたテキストを保存
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

    // 🔴 GAS通信の共通処理（ここで実際にインターネット越しにGASを叩きます）
    async callGasApi(payload) {
        const response = await fetch(this.gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' }, // GASのdoPostでCORSエラーを防ぐためtext/plainを指定
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || "GAS側で不明なエラーが発生しました");
        }
        return data.data; // 成功したデータの中身だけを返す
    }


    // --- 部署4: 結合・総仕上げ担当 ---
    async mergeAndCreateMinutes(meetingName, templateType) {
        console.log("🔗 テキストの結合を開始します...");
        const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
        const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');

        let resultData = { transcript: fullTranscript, documentUrl: null };

        // Step 3 (議事録化) の処理
        if (this.state.mode === '3') {
            console.log("📝 議事録化プロンプトと一緒にGASへ最終送信します...");
            
            const payload = {
                action: "generateMinutes",
                text: fullTranscript,
                meetingName: meetingName || "無題の会議",
                templateType: templateType || "汎用議事録"
            };

            const response = await this.callGasApi(payload);
            resultData.documentUrl = response.documentUrl;
            console.log("✅ 議事録ドキュメント完成: ", response.documentUrl);
        }

        // 処理完了後、日記を消去
        this.clearState();
        return resultData;
    }
}

// ==========================================
// 🚀 現場監督の出勤（インスタンス化）
// ==========================================
// グローバル変数として appController を作成し、HTML側から操作できるようにする
window.appController = new RecorderController(CONFIG);

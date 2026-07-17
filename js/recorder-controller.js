/**
 * レコーダーアプリ ミドルエンド（現場監督）
 * 役割：録音データの管理、進捗の記憶、GASへの並列送信＆自動リトライ、最終結合
 */
class RecorderController {
    constructor(gasUrl) {
        // バックエンド（GAS）のWebアプリURLをここに設定します
        this.gasUrl = gasUrl;
        
        // ① お財布ガード：1つのパーツにつき最大3回までしかリトライしない
        this.MAX_RETRIES = 3;
        
        // LocalStorageに保存するためのキー名
        this.STORAGE_KEY = 'recorder_app_state';
        
        // 現在の進捗状態（記憶）を呼び出す
        this.state = this.loadState() || this.createInitialState();
    }

    // ==========================================
    // 部署1: 記憶・進捗管理担当 (State Manager)
    // ==========================================
    
    // 初期状態の作成
    createInitialState() {
        return {
            sessionId: Date.now().toString(), // 今回の録音の固有ID
            mode: '3', // 処理モード（デフォルトは議事録まで）
            chunks: [], // 分割された音声パーツのリスト
            isCompleted: false
        };
    }

    // 日記（LocalStorage）を保存
    saveState() {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.state));
    }

    // 日記（LocalStorage）を読み込み
    loadState() {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        return saved ? JSON.parse(saved) : null;
    }

    // 処理がすべて終わったら日記を消去
    clearState() {
        localStorage.removeItem(this.STORAGE_KEY);
        this.state = this.createInitialState();
    }


    // ==========================================
    // 部署2: 録音・スライス担当 (Audio Splitter)
    // ==========================================
    
    // 10分ごとに切り分けられた音声データ（Blob）をリストに追加する
    addAudioChunk(blob, index) {
        this.state.chunks.push({
            id: index,
            blob: blob, // ※実際にはBlobはStorageに保存できないため、File API等でDriveに上げたURLを保持するのが理想です
            status: 'pending', // pending(未送信), processing(処理中), completed(完了), error(エラー)
            text: '', // 文字起こしされたテキストが入る箱
            retryCount: 0
        });
        this.saveState();
    }


    // ==========================================
    // 部署3: 通信・リトライ担当 (Network & Retry)
    // ==========================================

    // すべてのパーツを一斉に並列送信する（よーいドン！）
    async processAllChunks(onProgressCallback) {
        console.log("🚀 並列処理を開始します...");

        // まだ完了していない（未送信 or エラー）パーツだけを抽出
        const pendingChunks = this.state.chunks.filter(c => c.status !== 'completed');

        // Promise.all を使って一斉に送信（並列処理）
        const promises = pendingChunks.map(chunk => 
            this.sendChunkWithRetry(chunk, onProgressCallback)
        );

        // すべての並列処理が終わるまで待つ
        await Promise.all(promises);

        // 全パーツが完了したかチェック
        const allCompleted = this.state.chunks.every(c => c.status === 'completed');
        if (allCompleted) {
            console.log("🎉 すべての文字起こしが完了しました！");
            return await this.mergeAndCreateMinutes();
        } else {
            throw new Error("一部の処理がエラーで停止しました。手動再開をお願いします。");
        }
    }

    // 1つのパーツをGASに送信 ＆ 失敗したら自動リトライ（指数バックオフ）
    async sendChunkWithRetry(chunk, onProgressCallback) {
        chunk.status = 'processing';
        this.saveState();
        if(onProgressCallback) onProgressCallback(this.state.chunks);

        while (chunk.retryCount <= this.MAX_RETRIES) {
            try {
                // 待機時間（指数バックオフ: 0秒 → 2秒 → 4秒 → 8秒）
                const waitTime = chunk.retryCount === 0 ? 0 : Math.pow(2, chunk.retryCount) * 1000;
                if (waitTime > 0) {
                    console.warn(`⚠️ パーツ${chunk.id}: APIビジーのため ${waitTime/1000}秒待機して再送します...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }

                // --- 🔴 ここでGASへ送信（Fetch API） ---
                // ※現在はダミー通信。後ほど GAS側の仕様に合わせて連携コードを書きます
                const responseText = await this.mockGasApiCall(chunk);
                
                // 成功したら記録してループを抜ける
                chunk.status = 'completed';
                chunk.text = responseText;
                this.saveState();
                if(onProgressCallback) onProgressCallback(this.state.chunks);
                return true;

            } catch (error) {
                chunk.retryCount++;
                console.error(`❌ パーツ${chunk.id}: エラー発生 (${chunk.retryCount}回目)`);
                
                if (chunk.retryCount > this.MAX_RETRIES) {
                    // 最大リトライ回数を超えたら「エラー」として諦める（お財布ガード）
                    chunk.status = 'error';
                    this.saveState();
                    if(onProgressCallback) onProgressCallback(this.state.chunks);
                    return false;
                }
            }
        }
    }

    // GAS通信のダミー（テスト用）
    async mockGasApiCall(chunk) {
        return new Promise((resolve, reject) => {
            const isSuccess = Math.random() > 0.2; // 20%の確率で一時エラーが起きるテスト
            setTimeout(() => {
                if (isSuccess) resolve(`[パーツ${chunk.id}の文字起こし結果]`);
                else reject(new Error("API Busy"));
            }, 2000 + Math.random() * 2000);
        });
    }


    // ==========================================
    // 部署4: 結合・総仕上げ担当 (Text Stitcher)
    // ==========================================

    async mergeAndCreateMinutes() {
        console.log("🔗 テキストの結合を開始します...");

        // 必ず「id（背番号）順」に並び替えてからテキストを結合する
        const sortedChunks = [...this.state.chunks].sort((a, b) => a.id - b.id);
        
        // のりしろ（重複）を考慮して綺麗に繋ぐ処理（ここでは一旦単純結合）
        const fullTranscript = sortedChunks.map(c => c.text).join('\n\n');

        console.log("✅ 全文テキスト完成:\n", fullTranscript);

        // Step 3 (議事録化) へ進む
        if (this.state.mode === '3') {
            console.log("📝 議事録化プロンプトと一緒にGASへ最終送信します...");
            // TODO: ここでGAS(3.5 Flash)を呼び出す処理を書く
        }

        // 全て終わったら日記を消す
        this.clearState();
        return fullTranscript;
    }
}

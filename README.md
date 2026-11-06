# チューリング・テーブル（TURING TABLE）

**AI が作った AI に、人類は勝てるか。**

**遊ぶ: https://angrh0824.github.io/turing-table/**

ボードゲームやカードゲームのルール・画面・AI を、AI（Claude）が一から作ったゲーム集です。
AI は人間が作ったエンジン・棋譜・定石集を使わず、ルールだけから自己対局で強くしました。

- **軍儀**（2人）: HUNTER×HUNTER の盤上競技。駒を重ね、寝返らせる → https://angrh0824.github.io/turing-table/gungi/
- **リバーシ**（2人）: 自己対局だけで強くなった AI と、藍の漆塗りの盤で打つ → https://angrh0824.github.io/turing-table/reversi/
- **連珠**（2人）: 禁手ありの五目並べ。自己対局だけで強くなった AI に挑む → https://angrh0824.github.io/turing-table/renju/
- **花札こいこい**（2人）: 自己対局だけで育った AI と、和モダンの花札で読み合う → https://angrh0824.github.io/turing-table/koikoi/
- **ホールデム**（2〜6人）: 2〜6人のノーリミット・テキサスホールデム。自己対局の CFR で学んだ AI と、オンラインでは何人でも同じ卓で → https://angrh0824.github.io/turing-table/holdem/
- **将棋**（2人）: 自己対局だけで強くなった AI と、明朝体の駒で指す本将棋 → https://angrh0824.github.io/turing-table/shogi/
- **チェス**（2人）: 自己対局だけで強くなった AI と、大理石と真鍮の盤で指す → https://angrh0824.github.io/turing-table/chess/
- **麻雀**（4人）: 4人のリーチ麻雀。自己対局の強化学習だけで育った AI と、オンラインでは人間どうしでも同じ卓で → https://angrh0824.github.io/turing-table/mahjong/
- **囲碁**（2人）: 自己対局だけで育つ AlphaZero 型の AI と、榧の碁盤で打つ → https://angrh0824.github.io/turing-table/go/
- **バックギャモン**（2人）: 自己対局だけで育った AI と、革と木の盤でサイコロを振る → https://angrh0824.github.io/turing-table/backgammon/
- **大富豪**（4人）: 4人の大富豪（大貧民）。革命・8切り・しばり・都落ち・カード交換。自己対局だけで育った AI と、オンラインでは人間どうしも同じ卓で → https://angrh0824.github.io/turing-table/daifugo/
- **シャンチー**（2人）: 自己対局だけで強くなった AI と、木の盤と丸い駒で指す中国将棋（象棋） → https://angrh0824.github.io/turing-table/xiangqi/
- **ヨット**（1〜4人）: 昔から伝わるサイコロ遊び。5個のサイコロを3回まで振って12の役を埋める。ひとりで点数アタック、CPU や友だちと最大4人で → https://angrh0824.github.io/turing-table/yacht/
- **アマゾンズ**（2人）: 動いて、矢を放ち、盤を区切る。自己対局だけで育った AI と陣地を奪い合う → https://angrh0824.github.io/turing-table/amazons/
- **軍人将棋**（2人）: 駒の正体を隠したまま戦う、審判つきの昔の盤上遊戯。相手の駒を推理する AI と → https://angrh0824.github.io/turing-table/gunjin/
- **量子観測将棋**（2人）: 動かすほど駒の正体が絞られ、確定した玉を詰ませる。自己対局だけで育った AI と指す自作の将棋 → https://angrh0824.github.io/turing-table/kansoku/
- **ごいた**（4人）: 能登に伝わる、将棋の駒で遊ぶ2対2の札あそび。味方の CPU と組んで、先に150点 → https://angrh0824.github.io/turing-table/goita/
- **うそつきダイス**（2〜6人）: 伏せたサイコロの数を言い合い、はったりを見抜く。自己対局だけで育った CPU と2〜6人で → https://angrh0824.github.io/turing-table/dudo/

- CPU は4段階（いくつかのゲームは5段階目の「超最強」まで）。AI補助（形勢や最善手の表示）はどのゲームでも、ボタンを押すと出ます
- 勝つと XP・コインがたまり、レベル・実績・着せ替えのガチャで遊べます（お金はかかりません。記録はブラウザに残り、引き継ぎコードで別の端末へ移せます）
- オンライン対戦: トップ画面にいまのオンライン人数、各ゲームの対戦待ち・対局中の人数が出ます
- オンライン対戦は公開の MQTT 中継サーバー（broker.emqx.io / broker.hivemq.com）を通します。名前と指し手はほかの人からも見える可能性があります

このリポジトリは公開用の配布物だけを置いています（学習のプログラムやデータは含みません）。

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
- **将棋**（2人）: 自己対局だけで強くなった AI と、自作の駒と字で指す本将棋 → https://angrh0824.github.io/turing-table/shogi/
- **チェス**（2人）: 自己対局だけで強くなった AI と、大理石と真鍮の盤で指す → https://angrh0824.github.io/turing-table/chess/
- **麻雀**（4人）: 4人のリーチ麻雀。自己対局の強化学習だけで育った AI と、オンラインでは人間どうしでも同じ卓で → https://angrh0824.github.io/turing-table/mahjong/
- **囲碁**（2人）: 自己対局だけで育つ AlphaZero 型の AI と、榧の碁盤で打つ → https://angrh0824.github.io/turing-table/go/
- **バックギャモン**（2人）: 自己対局だけで育った AI と、革と木の盤でサイコロを振る → https://angrh0824.github.io/turing-table/backgammon/
- **大富豪**（4人）: 4人の大富豪（大貧民）。革命・8切り・しばり・都落ち・カード交換。自己対局だけで育った AI と、オンラインでは人間どうしも同じ卓で → https://angrh0824.github.io/turing-table/daifugo/
- **シャンチー**（2人）: 自己対局だけで強くなった AI と、木の盤と丸い駒で指す中国将棋（象棋） → https://angrh0824.github.io/turing-table/xiangqi/
- **ブロック陣取り**（2〜4人）: 形の違う21のピースを角だけでつないで陣地を広げる、2〜4人の陣取り。自己対局だけで育った AI と、オンラインでは何人でも同じ盤で → https://angrh0824.github.io/turing-table/blocks/

- CPU は4段階。AI補助（形勢や最善手の表示）はどのゲームでも使えます
- オンライン対戦: トップ画面にいまのオンライン人数、各ゲームの対戦待ち・対局中の人数が出ます
- オンライン対戦は公開の MQTT 中継サーバー（broker.emqx.io / broker.hivemq.com）を通します。名前と指し手はほかの人からも見える可能性があります

このリポジトリは公開用の配布物だけを置いています（学習のプログラムやデータは含みません）。

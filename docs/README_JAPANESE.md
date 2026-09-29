# Translate It!
> ウェブを、あなたらしい方法で翻訳。

<p align="center">
  <a target="_blank" href="https://chromewebstore.google.com/detail/translate-it/jfkpmcnebiamnbbkpmmldomjijiahmbd">
    <img src="../docs/Store/Chrome-Store.png" alt="Chrome" height="60" />
  </a>
  <a target="_blank" href="https://addons.mozilla.org/en-GB/firefox/addon/translate-it/">
    <img src="../docs/Store/Firefox-Store.png" alt="Firefox" height="60" />
  </a>
</p>

<br>

---

<br>

<div align="center">
  <strong>
    • <a href="../README.md">English</a> | 
    • <a href="./README_FARSI.md">فارسی</a> | 
    • 日本語
  </strong>
</div>

<br>

<p align="center">
  <img src="./Images/Options_Japanese.jpg" alt="Translate It 拡張機能" height="400" />
</p>

**Translate It** は単なる翻訳ツールではありません。あらゆるデバイスで言語の壁を越えるために設計された、高性能でモジュール式のエコシステムです。「ゼロプレッシャー」の哲学に基づいて設計されており、数十のタブが開いている状態でも、システムリソースに負荷をかけたり RAM を膨張させたりすることなく、モダンブラウザでシームレスに動作するように最適化されています。**Vue.js 3** で構築され、**10 以上のプロバイダー**に対応。プライバシー、スピード、そしてコスト効率に重点を置いた、ウェブ翻訳への緻密なアプローチを提供します。

<br>

<p align="center">
  <a href="https://youtu.be/VxgRWlx20wU">
    <b>YouTubeでデモを見る</b>
  </a>
  <br>
  <a href="https://youtu.be/VxgRWlx20wU">
    <img src="./Images/Windows.png" alt="動画を見る" width="560" />
  </a>
</p>

---

## 目標

- **プライバシーと選択肢:** 翻訳をどのように処理するかは自分で選べます。対応している機能ではローカルやオフラインのプロバイダーを使うことも、好みのクラウドサービスを設定することもできます。
- **プロバイダーを自由に選べる:** ひとつのサービスに縛られることなく、ローカル、無料、従来型、AI ベースのプロバイダーを用途に合わせて切り替えられます。
- **さまざまな場面で使える:** 選択したテキストや入力欄だけでなく、ページ内の要素、ページ全体、PDF、字幕、OCR、マウスホバー、ライブ音声まで、ひとつの拡張機能で対応します。
- **普段のブラウジングに合わせた設計:** 動的なページや長いコンテンツ、継続的な翻訳にも対応し、デスクトップでもモバイルでも快適に使えるよう設計されています。


---

## 機能一覧

| 機能 | 説明 |
| :--- | :--- |
| **テキスト選択** | テキストを選択した場所に翻訳アイコンやボックスを即座に表示。 |
| **要素モード** | UI 要素をクリックして、レイアウトを維持したままインラインで翻訳。 |
| **ページ全体翻訳** | 遅延読み込みとスマートなメモリ管理により、ページ全体を自動翻訳。 |
| **PDF翻訳** | ローカル/オンラインのPDFファイルを対訳表示、スキャンPDF向けOCR、TXT/Markdown/HTMLへのエクスポートに対応して翻訳。 |
| **マウスホバー翻訳** | テキストにマウスを合わせるだけで翻訳ツールチップを表示（単語/一文/コンテナの範囲指定に対応）。 |
| **デスクトップ/モバイル FAB** | OCR、要素モード、即時設定にアクセスできる多目的フローティングハブ。 |
| **入力欄翻訳 (Ctrl+/)** | 送信前にテキスト入力欄の内容をその場で翻訳。 |
| **スマート辞書** | 定義、類義語、使用例をマルチアクセントの音声合成とともに表示。 |
| **履歴とエクスポート** | 翻訳履歴を管理し、後で利用するためにエクスポート可能。 |
| **リソーストッカー** | ブラウザを高速に保つための高度なメモリ管理システム。 |

---

## 対応プロバイダー

Translate It は、一般的な翻訳サービス、AI、ローカル、辞書など、さまざまなプロバイダーに対応しています。

- **一般的な翻訳サービス:** [Google](https://translate.google.com/)、[Microsoft](https://www.microsoft.com/translator/)、[DeepL](https://www.deepl.com/translator)、[Yandex](https://translate.yandex.com/)、[Lingva](https://github.com/TheDavidDelta/lingva-translate)、[Bing](https://www.bing.com/translator)
- **AI:** [Gemini](https://ai.google.dev/)、[OpenAI](https://openai.com/api/)、[OpenRouter](https://openrouter.ai/)、[Requesty](https://www.requesty.ai/)、[DeepSeek](https://platform.deepseek.com/)
- **カスタム・ローカル:** OpenAI Compatible、[WebAI-to-API](https://github.com/Amm1rr/WebAI-to-API/)、Browser Translation
- **辞書:** [Vajehyab](https://vajehyab.com/)

API キーが必要なプロバイダーと、設定なしで使えるプロバイダーがあります。

---

## はじめに

### 1. インストール
最適な体験のために、公式ストアからインストールしてください：

<p align="center">
  <a target="_blank" href="https://chromewebstore.google.com/detail/translate-it/jfkpmcnebiamnbbkpmmldomjijiahmbd">
    <img src="../docs/Store/Chrome-Store.png" alt="Chrome" height="50" />
  </a>
  <a target="_blank" href="https://addons.mozilla.org/en-GB/firefox/addon/translate-it/">
    <img src="../docs/Store/Firefox-Store.png" alt="Firefox" height="50" />
  </a>
</p>

*手動でのインストールについては、[インストールガイド](./guides/INSTALLATION.md)をご覧ください。*

### 2. 設定
ほとんどの AI プロバイダーには API キーが必要です。
- [**API 設定ガイド**](./guides/API_GUIDE.md)に従って、Gemini や OpenAI などを設定してください。
- *Google や Yandex などの無料プロバイダーは、設定なしですぐに使用できます。*

### 3. ショートカットの活用
[**ユーザーガイド**](./guides/USAGE.md)でショートカットを確認し、生産性を最大限に高めましょう。

---

## 主な機能

### 1. 高度な翻訳エンジン
- **プログレッシブ・ストリーミング・エンジン:** 長い翻訳を待つ必要はありません！システムが長いテキストを最適化されたセグメントに分割し、準備ができたものからリアルタイムで表示します。すべてのプロバイダーでスムーズかつレスポンシブな体験を提供します。
- **10 以上のプロバイダー:** 高度な AI モデル（LLM）と従来のプロバイダー（Google、Microsoft、DeepL）を瞬時に切り替え可能。

<br>

### 2. 精密な要素翻訳（ポイント＆クリック）
- **視覚的ハイライト:** モードを有効にして、段落、ボタン、またはメニューにマウスを合わせると、リアルタイムでオレンジ色のハイライトが表示されます。クリックするだけで、その特定の要素を瞬時に翻訳します。
- **レイアウトの維持:** ウェブサイトの構造内で直接テキストを翻訳します。ページのレイアウトは 100% 維持されます。
- **ホバープレビュー:** 原文を確認したいですか？翻訳された要素にマウスを合わせるだけで、精密なツールチップで原文を表示します。
<!-- ELEMENT_SELECTION_SCREENSHOT_PLACEHOLDER -->

<br>

### 3. スマートなページ全体翻訳（遅延読み込み）
- **無限スクロール対応:** スクロールするたびに新しいコンテンツを自動的に検出し、翻訳します。SNS や長文記事に最適です。
- **2 つの実行モード:** 
  - **流動モード (Fluid):** コンテンツがビューポートに入ると同時にリアルタイムで翻訳します。
  - **停止時モード (On-Stop):** スクロールが終わるまで待機してから翻訳を開始し、API コストを節約し視覚的なノイズを軽減します。
<!-- WHOLE_PAGE_SCREENSHOT_PLACEHOLDER -->

<br>

### 4. スクリーンキャプチャ & OCR（あらゆるものをテキストへ）
- **ビジュアル翻訳:** 画像、動画、PDF、または選択不可能なウェブ領域からテキストをキャプチャして翻訳。
- **オフラインエンジン:** Tesseract.js を搭載。ローカルモデルのキャッシュにより、「完全オフライン」のプライバシーを実現。
<!-- OCR_SCREENSHOT_PLACEHOLDER -->

<br>

### 5. PDF翻訳
- **ローカル/オンラインのPDFファイル:** デバイス上のPDFファイルまたはURLからPDFを開けます。
- **インテリジェントなページ翻訳:** ページを必要に応じて翻訳し、対訳表示または翻訳表示で読めます。
- **ページ移動とテキスト選択:** ページ間を移動し、PDF内のテキストを選択できます。
- **スキャンPDFのOCRとエクスポート:** OCRでテキストを抽出し、翻訳をTXT、Markdown、HTMLでエクスポートできます。
<!-- PDF_TRANSLATOR_SCREENSHOT_PLACEHOLDER -->

<br>

### 6. 字幕翻訳 (SRT)
- **かんたんファイル翻訳:** 映画や講義の字幕ファイル（.srt）をアップロードするだけで、好きな言語にすぐ翻訳できます。
- **ズレない・壊れない:** 動画のタイミングや、斜体（イタリック）、太字などの装飾をそのまま維持します。ファイルが壊れる心配はありません。
- **リアルタイム表示:** 翻訳の進み具合を一行ずつ確認でき、完了までの残り時間もひと目でわかります。
- **長編動画もスムーズ:** 長い映画でも、一行も漏らすことなくスムーズに翻訳を完了させます。

<br>

### 7. スマート最適化スライダー（経済性 vs ターボ）
API コストと UI スピードを **最適化レベル（1〜5）** で完全にコントロール：
- **エコノミーモード（レベル 1）:** 1 回のリクエストで 70% 多くのテキストを処理。AI トークンの節約や、従来のプロバイダーでの IP バン防止に最適。
- **ターボモード（レベル 5）:** 並列処理を最大化し、最速の UI レスポンスを実現。
<!-- OPTIMIZATION_SLIDER_PLACEHOLDER -->

<br>

### 8. クロスプラットフォーム・エルゴノミクス
- **モバイル・ボトムシート:** Android 版 Firefox、Kiwi、Lemur などのモバイルブラウザ向けに、ジェスチャー操作に対応した親指で操作しやすいネイティブライクなインターフェース.
- **デスクトップ/モバイル FAB メニュー:** OCR、ページ翻訳、要素モード、および迅速な機能切り替え（インスタント TTS や直接翻訳モードなど）のための多目的ハブ。

<br>

### 9. マウスホバー翻訳 (インスタント・グランス)
- **一瞬で翻訳:** 修飾キー（Ctrlなど）を押しながらテキストにマウスを合わせるだけで、目立たないツールチップに翻訳結果を即座に表示します。
- **スマートな範囲指定:** 翻訳対象を自由に選択：**単語**、**一文**、または**コンテナ全体**を自動的に認識して翻訳します。

---

## 開発と貢献

Vue 3、Pinia、Vite を使用した **フィーチャーベース・アーキテクチャ** を採用しています。
- **アーキテクチャ:** モジュール化されたシステムの詳細は [ARCHITECTURE.md](./technical/ARCHITECTURE.md) をご覧ください。
- **貢献:** ローカルセットアップの手順については [CONTRIBUTING.md](./guides/CONTRIBUTING.md) をお読みください。
- **ローカライゼーション:** [ローカライゼーションガイド](./guides/LOCALIZATION_GUIDE.md)に従って、翻訳の追加や更新にご協力ください。

---

## ライセンス

このプロジェクトは **Apache License 2.0** の下でライセンスされています。

詳細は [LICENSE](../LICENSE) ファイルをご覧ください。

---

<p align="center">
  <a href="https://www.star-history.com/#Translate-It-App/Translate-It&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Translate-It-App/Translate-It&type=Date" />
  </a>
</p>

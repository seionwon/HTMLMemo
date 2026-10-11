# HTMLMemo

웹 페이지를 HTML 한 파일로 보관하고, 저장한 문서와 로컬 HTML에 주석을 남기는 독립 PWA입니다. 모든 문서·주석·설정은 기기 안에만 저장합니다. GitHub Pages는 설치할 앱의 정적 코드만 제공합니다. 데이터 저장용 서버·로그인·API 키는 사용하지 않습니다. HTMLMemoEx의 소스는 사용하지 않았습니다.

## 실행

사용자는 Node.js, 명령어, 서버 실행, 계정이 필요 없습니다. 설치 진입점은 맥·윈도우·안드로이드·아이폰 모두 **같은 주소 → Chrome → 앱 설치**로 통일합니다.

1. 배포가 완료된 뒤 Chrome으로 `https://sweon.github.io/HTMLMemo/`를 엽니다. 전달받은 `HTMLMemo-install.html`에서 **HTMLMemo 열기**를 눌러도 같은 주소로 이동합니다.
2. **앱 설치**를 누릅니다. 맥·윈도우·안드로이드는 가능한 경우 설치 창을 엽니다. 아이폰(iOS 16.4 이상)은 **Chrome 공유 → 홈 화면에 추가 → 추가** 순서를 안내합니다. iOS에서는 웹 앱의 버튼으로 이 메뉴를 자동 실행할 수 없습니다. [Google의 iPhone Chrome 안내](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=ko), [MDN 설치 기능](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
3. 설치한 앱 아이콘으로 연 뒤 **HTML 파일 가져오기**로 로컬 HTML을 읽고 주석을 남깁니다. 처음 로딩과 오프라인 준비를 마친 뒤에는 저장한 HTML을 오프라인으로 사용할 수 있습니다. 웹 탐색에는 인터넷이 필요합니다.

다른 사람에게는 실행 탭의 **앱 내보내기 / 설치 안내 파일 저장**으로 만든 `HTMLMemo-install.html` 하나를 전달합니다. 파일에는 설치 주소와 안내만 들어가며 개인 문서·주석·설정·파일 권한은 포함되지 않습니다. 이 안내 파일 자체가 PWA 설치 프로그램인 것은 아닙니다. Pages 배포와 첫 설치 시 인터넷 연결이 필요합니다.

## GitHub Pages 설정 · sweon/HTMLMemo

이 프로젝트는 **미리 빌드한 docs 폴더를 main 브랜치에 업로드**하는 한 가지 배포 절차를 사용합니다. API 토큰이나 별도의 Actions YAML 설정은 필요 없습니다. 아직 이 작업 환경에서 GitHub 계정에 연결하거나 저장소 업로드·Pages 활성화를 수행하지는 않았습니다.

1. **실행 탭 상단 → 배포 ZIP 다운로드**를 눌러 `HTMLMemo-pages.zip`을 받고 압축을 풉니다. 개인 문서·주석·설정은 포함되지 않습니다. 개발자 빌드(`npm run build`)의 동일한 파일은 `dist/downloads/HTMLMemo-pages.zip`에 있습니다.
2. [sweon/HTMLMemo](https://github.com/sweon/HTMLMemo)를 열고 **Code → Add file → Upload files**를 누릅니다. 빈 저장소라면 **uploading an existing file** 링크를 누릅니다.
3. 압축을 푼 **docs 폴더 전체**를 업로드 영역에 끌어놓습니다. 목록에 `docs/index.html`, `docs/src/app.js`, `docs/manifest.webmanifest` 등이 표시되는지 확인합니다. ZIP 파일 자체를 올리거나 `docs/docs/index.html`로 두지 마세요.
4. **Commit changes**로 `main` 브랜치에 저장합니다. 최초 업로드로 기본 브랜치를 만든 경우 이름이 `main`인지 확인합니다. 다른 기본 브랜치라면 아래 설정에서도 그 이름을 선택합니다.
5. 저장소 **Settings → Pages → Build and deployment → Source**를 **Deploy from a branch**로 선택합니다.
6. **Branch: main**, **Folder: /docs**를 선택하고 **Save**를 누릅니다.
7. **Actions**에서 `pages build and deployment`가 성공할 때까지 기다립니다. **Settings → Pages → Visit site**로 엽니다. 기본 도메인일 때 예상 주소는 `https://sweon.github.io/HTMLMemo/`입니다.
8. Pages 설정의 **Enforce HTTPS**를 확인합니다. 기본 `github.io` 주소는 HTTPS를 지원합니다. 사이트에서 앱 설치, 로컬 HTML 가져오기, 주석 후 다시 열기, 설정 JSON 저장·복원, 설치 후 비행기 모드에서 읽기를 확인합니다.

GitHub Free에서는 공개 저장소에 Pages를 사용할 수 있습니다. 비공개 저장소에서는 해당 기능을 지원하는 유료 플랜이 필요할 수 있습니다. Pages의 앱 코드는 공개될 수 있지만, 사용자 문서·주석·설정은 업로드 대상에 들어 있지 않습니다. [GitHub 게시 위치 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [HTTPS 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).

이후 업데이트도 새 배포 ZIP의 docs 폴더를 같은 저장소에 올리면 됩니다. 앱 코드가 바뀌면 새 오프라인 캐시 버전을 생성합니다. 사용자 IndexedDB와 설정을 지우는 코드가 배포에 포함되지 않습니다.

## GitHub API 설정

위의 웹 업로드 방식과 HTMLMemo 앱 사용에는 API 설정이 필요 없습니다. GitHub API로 업로드를 자동화하려는 경우에만 아래 토큰을 만듭니다. HTMLMemo의 웹 설정 화면에는 토큰을 입력하지 않습니다.

1. GitHub 우측 프로필 **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**을 엽니다.
2. 이름은 `HTMLMemo-upload`, 만료는 필요한 기간(예: 30일), **Resource owner: sweon**으로 설정합니다.
3. **Repository access → Only select repositories → HTMLMemo**만 선택합니다.
4. **Repository permissions → Contents: Read and write**를 부여합니다. Metadata 읽기 권한은 기본입니다. 준비된 배포 ZIP에는 Actions workflow 파일이 없으므로 **Workflows 권한은 필요 없습니다**. Pages는 위의 Settings 화면에서 설정하므로 **Pages·Administration 권한도 필요 없습니다**.
5. **Generate token**으로 발급하고 업로드용 개발 도구의 자격 증명 저장소에 넣습니다. 토큰을 채팅·앱 HTML·설정 JSON·저장소·URL에 넣지 마세요. [GitHub 공식 토큰 생성 안내](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

이는 업로드 자동화의 인증 준비입니다. 앱에는 업로드용 GitHub API 호출이나 토큰 저장 기능을 추가하지 않았습니다. GitHub API로 Pages 설정까지 자동화하려면 해당 API에 필요한 권한을 별도로 지정해야 하며, 이 프로젝트의 기본 배포 과정에는 필요 없습니다.

## 개발 환경

개발 환경에서 최신 실행 파일을 생성하고 여는 명령은 아래와 같습니다. 이 명령도 서버를 시작하지 않습니다.

```sh
npm run dev
```

전달할 파일을 만들기만 하려면 다음 명령을 실행합니다. 개발자 빌드에는 Node.js 22 이상을 사용하며 외부 실행 패키지는 필요 없습니다.

```sh
npm run build
npm run package
```

배포용 결과는 `dist/downloads/HTMLMemo-pages.zip`, 사용자 전달용 결과는 `dist/downloads/HTMLMemo-install.html`입니다. 이 빌드는 파일만 생성하며 GitHub 업로드나 Pages 활성화를 하지 않습니다. 로컬 코드 검토에는 생성된 `public/HTMLMemo.html`을 사용할 수 있습니다. `file://`는 PWA 설치 대상이 아니므로 로컬 파일에서는 설치 주소로 이동하도록 안내합니다.

## 웹 탐색과 저장

주소창은 URL과 검색어를 받습니다. 프레임 표시를 허용하는 페이지는 앱 내부에서 탐색합니다. 모든 사이트의 탐색과 로그인 세션을 사용한 캡처는 함께 제공하는 Chrome 확장 기능을 연결합니다. 연결하면 주소창에서 연 페이지가 실제 Chrome 탭으로 열리며, 앱에서 뒤로·앞으로·새로고침·페이지 저장을 사용할 수 있습니다.

1. 앱의 **Chrome 연결 → Chrome 연결 파일 저장**을 누르고 ZIP을 풀어 `extension/` 폴더를 준비합니다.
2. `chrome://extensions`에서 개발자 모드를 켜고 「압축해제된 확장 프로그램 로드」로 해당 폴더를 선택합니다.
3. HTMLMemo 앱을 새로고침합니다. 기본 연결 주소는 `https://sweon.github.io/HTMLMemo/`입니다. 해당 프로젝트의 루트 및 `index.html`만 연결을 허용하며 다른 GitHub Pages 프로젝트는 허용하지 않습니다.
4. 앱 또는 웹 페이지의 확장 기능에서 「페이지 저장」을 누릅니다. 저장된 로컬 HTML이 앱의 새 주석 탭에 자동으로 열립니다.

스타일시트와 중첩 CSS import, 이미지, CSS 이미지, 글꼴, 캔버스, 입력 상태를 HTML 안에 포함합니다. 확장 기능은 설정한 앱에만 요청을 전달하고, 사용자가 저장한 페이지의 내용을 처리합니다. 사용 권한은 `extension/manifest.json`에서 확인할 수 있습니다.

웹 탐색과 원본 리소스 읽기에는 인터넷이 사용되지만 앱 데이터를 서버에 저장하거나 동기화하지 않습니다. 확장 기능은 `chrome.storage.local`과 `chrome.storage.session`만 사용합니다. 안드로이드·아이폰의 Chrome은 이 데스크톱 확장 기능을 지원하지 않으므로 모든 사이트의 Chrome 탭 캡처까지 네 플랫폼에서 같게 동작하는 것은 아닙니다. 모바일에서는 로컬 HTML 가져오기·주석·앱 내부 자동 저장·HTML 내보내기를 사용할 수 있습니다.

## 설정 파일

설정의 **설정 파일 저장**으로 테마·서재 정렬·주석 색상·굵기·투명도·펜 표시 시간·툴바 위치를 `HTMLMemo-settings.json`에 저장합니다. **설정 파일 불러오기**로 다시 적용할 수 있습니다. 파일 핸들을 연결한 경우 **다시 불러오기**는 같은 파일의 최신 내용을 읽습니다. 파일 선택 API를 지원하지 않는 경우에도 일반 파일 선택과 다운로드로 저장·복원을 사용할 수 있습니다.

잘못된 JSON, 다른 앱의 파일, 지원하지 않는 버전·값은 적용 전에 거부합니다. 설정 파일에는 문서나 파일 접근 권한을 넣지 않습니다. 저장 폴더 이름은 안내용으로만 보관하며, 새 기기에서 폴더를 한 번 연결해야 합니다. 직접 연 HTML과 확장 기능 앱은 출처가 달라 보관함이 별도이므로 문서는 HTML 내보내기, 설정은 JSON으로 옮기세요.

## 로컬 HTML과 주석

HTML 파일 선택, 파일 드래그, 서재에서 다시 열기 모두 동일한 주석 리더를 사용합니다. 원본 HTTPS 주소가 파일에 남아 있어도 로컬 문서 탭으로 처리합니다. 파일 쓰기 권한이 없어도 주석은 활성화됩니다.

한 줄 플로팅 툴바에서 선택·펜·형광펜·밑줄·지우개·메모를 사용할 수 있습니다. 색상·굵기·투명도 설정, 임시 펜, 실행 취소·다시 실행, 확대, 도형·화살표·영역 강조·취소선·텍스트, 문서 검색, 목차·북마크, 주석 목록은 버튼과 추가 도구 메뉴에서 엽니다. 손잡이를 드래그하면 툴바를 이동할 수 있습니다. 문서 내부 링크로 이동한 후 뒤로 버튼으로 출발 위치에 돌아갈 수 있습니다.

단축키: `V` 선택, `P` 펜, `H` 형광펜, `U` 밑줄, `E` 지우개, `N` 메모, `Ctrl/⌘ Z` 실행 취소, `Ctrl/⌘ Shift Z` 다시 실행, `Ctrl/⌘ F` 문서 검색, `Ctrl/⌘ S` 저장, `Ctrl/⌘ L` 주소창. 읽던 위치와 확대 비율도 문서에 보관합니다.

## 자동 저장 위치

- **앱 보관함:** 주석 변경 후 전체 HTML을 IndexedDB에 저장하고, 지원하는 브라우저에서는 내부 파일 시스템(OPFS)의 `.html` 파일에도 기록합니다. 읽기와 주석은 오프라인에서도 가능합니다.
- **연결된 원본 파일:** 파일 선택 시 쓰기 권한이 허용되면 원본 HTML을 자동 갱신합니다. 읽기 전용으로 열거나 드래그한 파일은 추가 도구의 「파일 연결 / 저장 재시도」에서 원본 쓰기 권한을 연결할 수 있습니다.
- **저장 폴더:** 폴더를 한 번 연결하면 이후 저장한 웹 페이지는 해당 폴더에 생성되고, 주석도 같은 HTML에 자동 저장됩니다. 같은 제목의 기존 파일은 덮어쓰지 않습니다.
- **내보내기:** 파일 연결 API를 지원하지 않는 브라우저에서는 앱 내부에 자동 보관하고, 「HTML 내보내기」로 주석이 포함된 파일을 내려받습니다. 내려받은 외부 파일은 브라우저가 자동 갱신할 수 없습니다.

주석은 HTML 안의 `htmlmemo-data` JSON과 보이는 텍스트 표시·SVG로 저장합니다. 파일 하나를 다른 기기로 옮겨 HTMLMemo에서 열어도 주석을 복원하고 계속 편집할 수 있습니다. 외부 파일 쓰기가 실패하면 실패 상태와 재시도 버튼을 표시하고, 성공 전에 탭을 닫지 않습니다. 다른 프로그램이 원본을 변경한 경우에는 자동 덮어쓰기를 중단합니다. 앱 데이터 삭제는 내부 보관함을 지우므로 중요한 문서는 외부 파일로 연결하거나 내보내세요.

## 지원 범위

PWA만으로는 다른 출처의 페이지 DOM에 접근하거나 프레임 표시가 금지된 사이트를 표시할 수 없습니다. 이 경우 실제 Chrome 탐색과 확장 기능을 사용합니다. 근거: [같은 출처 정책](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy), [X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options).

저장은 현재 로딩된 문서의 정적 스냅샷입니다. 원본 사이트의 실행 스크립트와 비밀번호 입력 값은 보관하지 않습니다. 스트리밍 영상·음원, 보호된 캔버스, 다른 출처의 외부 프레임, 아직 생성되지 않은 동적 콘텐츠는 완전히 보관할 수 없습니다. 리소스 하나는 25MB, 합계는 150MB로 제한하며, 빠진 리소스는 문서 정보에 표시합니다. 외부 CSS·이미지를 따로 참조하는 로컬 HTML은 해당 파일 하나만 선택하면 외부 파일을 함께 읽을 수 없으므로, 자체 포함 HTML을 권장합니다.

원본 자동 갱신은 브라우저의 파일 쓰기 권한에 따릅니다. 권한 재승인은 사용자 클릭이 필요합니다. [Chrome File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## 검증

```sh
npm install
npm run check
npm test
npm run build
```

단위·DOM 모델 검사는 로컬 파일 읽기, 읽기 전용 주석 경로, UTF 인코딩, 단일 파일 캡처, 주석 복원과 HTML 안전 처리, 편집 기록·동시 저장, 원본 수정 충돌·쓰기 실패, Chrome 확장 메시지와 캡처 전달을 검사합니다. 추가로 네트워크 요청을 차단한 상태에서 실제 단일 HTML의 스크립트를 실행해 설치 버튼의 일반 Chrome·iPhone 분기, 실행 탭의 단일 안내 파일 내보내기, Pages ZIP과 오프라인 파일 목록·캐시 버전, 실패 후 버튼 복구, 설정 저장·복원을 검사합니다. DOM 모델 검사는 실제 Chrome 화면 렌더링 또는 OS 설치 검사가 아닙니다.

```sh
npm run test:browser
```

별도 Chrome 프로필과 localhost 테스트 서버로 웹 탐색 → 캡처 → 로컬 주석 → 실제 파일 핸들 저장 → 파일 가져오기 → 다시 열기 → 오프라인 흐름을 검사합니다. Chrome 경로가 자동 감지되지 않으면 `CHROME_PATH`를 지정합니다. 현재 작업 환경에서는 localhost 포트와 Chrome 실행이 차단되어 이 실제 브라우저 검사는 수행하지 못했습니다. 설치된 Chrome 확장 기능의 실사용 검증도 별도로 필요합니다.

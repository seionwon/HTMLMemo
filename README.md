# HTMLMemo

웹 페이지를 HTML 한 파일로 보관하고, 저장한 문서와 로컬 HTML에 주석을 남기는 독립 PWA입니다. 모든 문서·주석·설정은 기기 안에만 저장합니다. GitHub Pages는 설치할 앱의 정적 코드만 제공합니다. 데이터 저장용 서버·로그인·API 키는 사용하지 않습니다.

## 설치와 URL 공유

사용자는 맥·윈도우·안드로이드·아이폰 모두 **같은 주소 → Chrome → 앱 설치**로 시작합니다.

1. GitHub Pages 게시가 완료된 뒤 Chrome으로 https://seionwon.github.io/HTMLMemo/ 를 엽니다.
2. **앱 설치**를 누릅니다. 맥·윈도우·안드로이드는 가능한 경우 설치 창을 엽니다. 아이폰(iOS 16.4 이상)은 **Chrome 공유 → 홈 화면에 추가 → 추가** 순서를 안내합니다. [Google의 iPhone Chrome 안내](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=ko), [MDN 설치 기능](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
3. 설치한 앱 아이콘으로 연 뒤 **HTML 파일 가져오기**로 로컬 HTML을 읽고 주석을 남깁니다. 처음 로딩과 오프라인 준비를 마친 뒤에는 저장한 HTML을 오프라인으로 사용할 수 있습니다. 웹 탐색에는 인터넷이 필요합니다.

다른 사람에게는 **https://seionwon.github.io/HTMLMemo/** 주소만 보냅니다. 앱 내부의 **실행 → URL 복사**로 복사하거나 표시된 주소를 직접 선택해 복사할 수 있습니다. 복사 권한이 없으면 주소를 선택하는 안내를 표시하고 버튼을 다시 사용할 수 있게 복구합니다. 앱 전달용 ZIP과 설치 안내 HTML을 만들지 않습니다. 문서·주석·설정은 공유 URL에 포함되지 않으며 받은 사람의 데이터도 자신의 기기에 저장됩니다.

## GitHub Pages 자동 배포 · seionwon/HTMLMemo

배포 절차는 **프로젝트 소스를 main에 저장 → GitHub Actions가 검사·빌드 → GitHub Pages 게시**입니다. 앱 사용자는 주소만 받습니다. 배포 소스는 이 저장소의 public/, extension/, scripts/, tests/, package.json, package-lock.json과 .github/workflows/deploy-pages.yml입니다.

1. [seionwon/HTMLMemo](https://github.com/seionwon/HTMLMemo)에 프로젝트 소스와 **.github/workflows/deploy-pages.yml**을 main 브랜치로 저장합니다.
2. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 선택합니다. 기존에 main /docs로 설정했다면 GitHub Actions로 변경합니다.
3. **Actions → Deploy HTMLMemo to GitHub Pages → Run workflow**를 누릅니다. 이후 main 브랜치의 변경은 자동으로 배포를 실행합니다.
4. 검사·빌드·배포가 모두 성공하면 **Settings → Pages → Visit site**에서 게시 주소를 확인합니다. 기본 주소는 https://seionwon.github.io/HTMLMemo/ 입니다.
5. 사이트에서 앱 설치, 로컬 HTML 가져오기와 주석, 설정 JSON 저장·복원, 설치 후 오프라인 읽기를 확인합니다.

워크플로는 npm ci, npm test, npm run check, npm run build를 실행하고 **dist/만** GitHub Pages에 게시합니다. 개인 문서·설정·첨부·개발 의존성은 웹 빌드에 포함하지 않습니다. 검사나 빌드가 실패하면 배포 작업을 실행하지 않습니다. 앱 코드 또는 연결 기능의 코드가 바뀌면 오프라인 캐시 버전도 변경하며 기기의 문서 저장소는 지우지 않습니다.

GitHub Pages의 Source 설정과 실제 사이트 게시가 완료되어야 주소를 다른 사용자에게 전달할 수 있습니다. 2026-10-13에는 사용자가 선택한 라이브러리 데스크 디자인을 `84a6de7`로 main에 push하고 GitHub Actions·Pages 게시 성공을 확인했습니다. 게시된 HTML·CSS·아이콘·manifest·앱 JavaScript가 로컬 빌드와 일치함도 검증했습니다. 로컬 빌드 성공만으로 실제 게시 완료를 표시하지 않습니다. [GitHub Actions를 통한 Pages 배포](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## GitHub 게시 인증

앱 사용과 Actions 배포에는 앱에 입력할 API 키가 필요 없습니다. Actions는 GitHub가 제공하는 GITHUB_TOKEN을 사용하며 사용자 문서와 설정을 읽지 않습니다. 프로젝트 소스를 GitHub에 올리는 개발 도구는 저장소에 쓰기 권한이 있는 계정으로 로그인해야 합니다.

API로 소스와 워크플로를 업로드할 경우에만 fine-grained 토큰을 준비합니다.

1. GitHub 우측 프로필 **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**을 엽니다.
2. **Resource owner: seionwon**, **Repository access → Only select repositories → HTMLMemo**를 선택합니다.
3. **Repository permissions → Contents: Read and write**, **Workflows: Read and write**를 부여합니다. 워크플로 파일을 업로드하므로 Workflows 권한도 필요합니다.
4. 토큰은 개발 도구의 자격 증명 저장소에서 사용합니다. 앱·설정 JSON·저장소·URL에는 넣지 않습니다. [GitHub 공식 토큰 생성 안내](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Pages의 게시 소스 설정은 위의 Settings 화면에서 한 번 진행합니다. 앱에는 GitHub 토큰 저장이나 업로드 API 기능을 추가하지 않습니다.

현재 개발 서버에서는 저장소에 지정된 seionwon 계정의 인증을 사용합니다. `gh auth status`의 전역 활성 계정이나 이전 실행 환경의 연결 오류만으로 게시가 불가능하다고 판단하지 않습니다. 관련 소스·검증·이력을 커밋한 뒤 `git push origin main`으로 기존 Actions 배포를 실행하고, 해당 커밋의 게시 성공과 온라인 파일 일치를 확인합니다. API 연결 오류와 localhost `listen EPERM`은 각각 현재 실행 환경에서 다시 확인합니다. 이 프로젝트의 작업 지침은 [AGENTS.md](AGENTS.md)에 있습니다.

## 개발 환경

Node.js 22 이상에서 검사와 빌드를 실행합니다.

```sh
npm ci
npm test
npm run check
npm run build
```

빌드 결과인 **dist/**는 GitHub Pages의 웹 루트로 게시할 정적 앱입니다. 빌드는 앱 전달용 ZIP이나 설치 안내 파일을 생성하지 않습니다. 실제 업로드와 Pages 게시에는 GitHub 인증과 저장소 설정이 필요합니다.

개발자가 서버 없이 코드를 검토할 때는 npm run dev로 생성된 public/HTMLMemo.html을 열 수 있습니다. 이 파일은 개발 검토용이며 사용자에게 전달하는 설치 파일이 아닙니다. 사용자 설치와 공유는 위의 Pages 주소로 진행합니다.

## 웹 탐색과 저장

주소창은 URL과 검색어를 받습니다. 프레임 표시를 허용하는 페이지는 앱 내부에서 탐색합니다. 모든 사이트의 탐색과 로그인 세션을 사용한 캡처는 함께 제공하는 Chrome 확장 기능을 연결합니다. 연결하면 주소창에서 연 페이지가 실제 Chrome 탭으로 열리며, 앱에서 뒤로·앞으로·새로고침·페이지 저장을 사용할 수 있습니다.

1. 앱의 **Chrome 연결 → Chrome 연결 파일 저장**을 누르고 ZIP을 풀어 `extension/` 폴더를 준비합니다.
2. `chrome://extensions`에서 개발자 모드를 켜고 「압축해제된 확장 프로그램 로드」로 해당 폴더를 선택합니다.
3. HTMLMemo 앱을 새로고침합니다. 기본 연결 주소는 `https://seionwon.github.io/HTMLMemo/`입니다. 해당 프로젝트의 루트 및 `index.html`만 연결을 허용하며 다른 GitHub Pages 프로젝트는 허용하지 않습니다.

4. 앱 또는 웹 페이지의 확장 기능에서 「페이지 저장」을 누릅니다. 저장된 로컬 HTML이 앱의 새 주석 탭에 자동으로 열립니다.

이전 주소에서 사용하던 Chrome 연결 기능은 새 연결 기능으로 교체하거나 다시 로드한 뒤, 연결 설정의 **HTMLMemo PWA에 연결**을 누릅니다. 이전 사이트 주소에 저장된 보관함은 새 사이트로 자동 이동하지 않습니다. 기존 문서는 HTML로 내보내고 설정은 JSON으로 저장한 뒤 새 주소에서 가져옵니다.

스타일시트와 중첩 CSS import, 이미지, CSS 이미지, 글꼴, 캔버스, 입력 상태를 HTML 안에 포함합니다. 확장 기능은 설정한 앱에만 요청을 전달하고, 사용자가 저장한 페이지의 내용을 처리합니다. 사용 권한은 `extension/manifest.json`에서 확인할 수 있습니다.

웹 탐색과 원본 리소스 읽기에는 인터넷이 사용되지만 앱 데이터를 서버에 저장하거나 동기화하지 않습니다. 확장 기능은 `chrome.storage.local`과 `chrome.storage.session`만 사용합니다. 안드로이드·아이폰의 Chrome은 이 데스크톱 확장 기능을 지원하지 않으므로 모든 사이트의 Chrome 탭 캡처까지 네 플랫폼에서 같게 동작하는 것은 아닙니다. 모바일에서는 로컬 HTML 가져오기·주석·앱 내부 자동 저장·HTML 내보내기를 사용할 수 있습니다.

## 설정 파일

설정의 **설정 파일 저장**으로 테마·서재 정렬·주석 색상·굵기·투명도·펜 표시 시간·툴바 위치를 `HTMLMemo-settings.json`에 저장합니다. **설정 파일 불러오기**로 다시 적용할 수 있습니다. 파일 핸들을 연결한 경우 **다시 불러오기**는 같은 파일의 최신 내용을 읽습니다. 파일 선택 API를 지원하지 않는 경우에도 일반 파일 선택과 다운로드로 저장·복원을 사용할 수 있습니다.

잘못된 JSON, 다른 앱의 파일, 지원하지 않는 버전·값은 적용 전에 거부합니다. 설정 파일에는 문서나 파일 접근 권한을 넣지 않습니다. 저장 폴더 이름은 안내용으로만 보관하며, 새 기기에서 폴더를 한 번 연결해야 합니다. 직접 연 HTML과 확장 기능 앱은 출처가 달라 보관함이 별도이므로 문서는 HTML 내보내기, 설정은 JSON으로 옮기세요.

## 로컬 HTML과 주석

HTML 파일 선택, 파일 드래그, 서재에서 다시 열기 모두 동일한 주석 리더를 사용합니다. 원본 HTTPS 주소가 파일에 남아 있어도 로컬 문서 탭으로 처리합니다. 파일 쓰기 권한이 없어도 주석은 활성화됩니다.

한 줄 플로팅 툴바에서 선택·펜·형광펜·밑줄·지우개·메모를 사용할 수 있습니다. 색상·굵기·투명도 설정, 임시 펜, 실행 취소·다시 실행, 확대, 도형·화살표·영역 강조·취소선·텍스트, 문서 검색, 목차·북마크, 주석 목록은 버튼과 추가 도구 메뉴에서 엽니다. 손잡이를 드래그하면 툴바를 이동할 수 있습니다. 문서 내부 링크로 이동한 후 뒤로 버튼으로 출발 위치에 돌아갈 수 있습니다.

문서 pane 오른쪽 위의 **전체 화면** 또는 **F**로 문서만 화면을 채우고, **전체 화면 종료** 또는 **Esc**로 돌아옵니다. 이 모드에서도 주석 툴바·주석 편집·자동 저장을 사용할 수 있습니다. 브라우저 전체 화면 API가 없거나 허용되지 않으면 앱 내부의 문서 전용 화면으로 전환합니다. 툴바의 기존 버튼·아이콘·순서·크기를 유지하면서 바깥 상하 여백은 0px, 좌우는 1px로 줄였으며 좁은 화면에서는 가로 스크롤로 모든 버튼에 접근합니다.

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

단위·DOM 모델 검사는 로컬 파일 읽기, 읽기 전용 주석 경로, UTF 인코딩, 단일 파일 캡처, 주석 복원과 HTML 안전 처리, 편집 기록·동시 저장, 원본 수정 충돌·쓰기 실패, Chrome 확장 메시지와 캡처 전달을 검사합니다. 추가로 네트워크 요청을 차단한 상태에서 실제 앱 스크립트를 실행해 설치 버튼의 일반 Chrome·iPhone 분기, 실행 탭의 URL 복사와 권한 실패 후 직접 복사 안내, 중복 복사 방지, 공개 웹 파일의 개인 데이터 제외와 오프라인 파일 목록·캐시 버전, 설정 저장·복원을 검사합니다. 실제 빌드에서 폐기한 배포 파일을 제거하고 dist/에 웹 앱만 생성하는지도 검사합니다. DOM 모델 검사는 실제 Chrome 화면 렌더링 또는 OS 설치 검사가 아닙니다.

```sh
npm run test:browser
```

별도 Chrome 프로필과 localhost 테스트 서버로 웹 탐색 → 캡처 → 로컬 주석 → 실제 파일 핸들 저장 → 파일 가져오기 → 다시 열기 → 오프라인 흐름을 검사합니다. Chrome 경로가 자동 감지되지 않으면 `CHROME_PATH`를 지정합니다. 2026-10-13 후속 검증에서는 전체 화면의 도구 유지·주석 저장과 대용량 File 우선 표시까지 포함한 실제 Chrome 검사 7개가 통과했습니다. 앞선 제한된 실행 환경의 실패 기록은 기능 이력에 보존합니다. 설치된 Chrome 확장 기능의 실사용 검증과 원본 대용량 파일의 Chrome 직접 열기 대비 시간 비교는 별도로 필요합니다.


## 라이브러리 데스크 디자인

앱은 `public/design.tailwind.css`의 CSS-first `@theme`와 실제 HTML·JavaScript에서 사용하는 유틸리티를 Tailwind CSS **4.3.3**으로 로컬 컴파일합니다. `npm ci` 후 `npm run build` 또는 `npm run dev`를 실행하면 `public/styles.css`를 갱신합니다. 브라우저에서 Tailwind 런타임이나 CDN을 사용하지 않습니다. GitHub Actions도 같은 고정 버전 의존성과 빌드 단계를 사용합니다.

데스크톱에서는 왼쪽 서재 탐색 메뉴, 모바일에서는 상단에 줄바꿈되는 메뉴를 사용합니다. 기존 설정의 시스템·밝게·어둡게 선택을 유지합니다. SVG favicon과 앱 브랜드, 192·512px PWA 설치 아이콘에 새 문서 심볼을 적용했으며 단일 HTML에도 브랜드 아이콘을 포함합니다.

큰 로컬 HTML(4MiB 이상, UTF-8)은 File/Blob을 브라우저 리더에 먼저 전달하여 화면을 표시합니다. 전체 파일 문자열 읽기·별도 DOM 파싱·IndexedDB 저장을 먼저 기다리지 않습니다. 브라우저가 만든 DOM에서 주석 준비를 나눠 진행하고 완료 후 자동 저장합니다. UTF-16 등 다른 인코딩은 기존 인코딩 변환 경로를 유지합니다. 주석 툴바는 모든 버튼·아이콘을 유지하면서 세로 버튼 공간을 19px로 줄여, 테두리 포함 약 21px 높이를 사용합니다. 실제 대용량 파일의 Chrome 직접 열기와 동일한 소요 시간은 아직 검증하지 못했습니다.

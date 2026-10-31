# LibreMemo 작업 지침

## GitHub Pages 게시

- 제품 이름은 LibreMemo(구 HTMLMemo)입니다. 계정은 `seionwon`, 브랜치는 `main`입니다. 저장소 이름 변경 전에는 `seionwon/HTMLMemo`와 `https://seionwon.github.io/HTMLMemo/`, 변경 뒤에는 `seionwon/LibreMemo`와 `https://seionwon.github.io/LibreMemo/`를 사용합니다. 현재 origin과 실제 GitHub 이름을 확인하고, 새 주소가 게시되기 전에 전환 완료로 기록하지 않습니다. 다른 MemoSuite 프로젝트의 계정과 혼동하지 않습니다.
- [저장소 전환 안내](docs/rename-to-librememo.md)에 따라 기존 주소에 변경 버전을 먼저 게시한 뒤 저장소를 바꿉니다. 기존 데이터·저장 폴더 관리 파일·동기화 규약의 호환 식별자를 기계적으로 이름 변경하지 않습니다. 실제 소스 폴더는 기존 CodeMemo 대화가 사용하는 `HTMLMemo` 경로를 유지합니다.
- 현재 저장소의 origin URL과 credential username을 사용합니다. 전역 `gh auth switch`, 토큰을 포함한 원격 URL, 자격 증명 출력으로 인증을 바꾸지 않습니다. 토큰·개인 문서·기기 설정을 소스나 빌드에 넣지 않습니다.
- 사용자가 게시를 요청했으면 소스 검사·빌드·필요한 실제 Chrome 검사, 관련 파일만 커밋, `git push origin main`, 해당 커밋의 GitHub Actions·Pages 게시 성공, 온라인 파일과 화면 확인까지 진행합니다. 로컬 빌드만 완료한 상태를 배포 완료로 표현하지 않습니다.
- 기존 `.github/workflows/deploy-pages.yml`이 main push 뒤 검사·빌드·게시를 수행합니다. 게시 소스는 GitHub Actions이며 dist만 공개됩니다. 이미 정상인 Source 설정을 다시 바꾸거나 별도 공개 서버를 만들지 않습니다.
- 연결 오류가 나면 현재 환경에서 저장소 접근과 GitHub API를 다시 확인하고 GitHub 응답, 인증 실패, 명령 실행 환경의 네트워크 제한을 구분합니다. 이전 대화나 이력의 접속 오류만으로 현재 연결도 차단되어 있다고 판단하지 않습니다.
- CodeMemo의 Codex 권한에서 `workspace-write`는 프로젝트 수정만 허용하고 인터넷을 차단하며, `workspace-network`는 프로젝트 수정과 인터넷을 허용합니다. GitHub와 localhost를 사용하는 작업이 막히면 해당 대화의 이 설정을 함께 확인합니다. 허용된 서버 게시 경로에서 완료할 수 있는 작업을 GitHub 장애라고 단정해 중단하지 않습니다. 기기에 저장된 사용자의 권한 선택을 임의로 변경하지 않습니다.
- CodeMemo의 Codex 프로젝트 수정 모드는 이름 있는 권한 프로필로 프로젝트 내부 `.git` 쓰기를 허용합니다. 인터넷 사용 여부는 기존 대화 선택을 그대로 따르며 계획·읽기 전용 모드에서는 Git 쓰기를 허용하지 않습니다. 이전 실행에서 `.git/index.lock` 쓰기가 막혔다는 기록만으로 새 실행도 불가능하다고 단정하지 말고 현재 권한으로 확인합니다. 이미 실행 중인 턴에는 서버의 새 실행 설정이 소급 적용되지 않습니다. 전체 접근 권한 해제나 다른 프로젝트 경로 허용으로 해결하지 않습니다.
- `listen EPERM`은 해당 실행 환경에서 localhost 실행이 제한됐다는 근거이며 GitHub 장애의 근거가 아닙니다. Chrome 검사는 별도 임시 프로필을 사용하고 사용자의 실제 브라우저 프로필을 사용하지 않습니다.
- 실행 환경이 네트워크를 막는다면 설정된 권한을 임의로 우회하지 않습니다. CodeMemo의 기존 게시 기능 등 이미 허용된 배포 경로에서 게시를 이어갑니다. 환경의 권한 변경과 GitHub 자체 장애를 구분해 기록합니다.

## 검증과 기록

`npm run check`, `npm test`, `npm run build`로 검사합니다. 문서 화면·파일 저장·리더 동작을 바꾸면 가능한 환경에서 `npm run test:browser`로 실제 Chrome 동작을 확인합니다. 실행하지 못한 검사를 통과했다고 쓰지 않습니다.

사용자에게 영향을 주는 변경과 운영 반영 결과는 `docs/기능 추가 history.md`에 한국어로 기록합니다. 이전 실패 기록을 삭제하지 말고 같은 항목에 실제 후속 검증·게시 결과를 보충합니다. 다른 작업의 변경과 `codememo-integration/`의 미적용 패치는 자동으로 커밋하지 않습니다.

## macOS 자동 브라우저 검사

`CODEX_SANDBOX=seatbelt` 또는 `CODEMEMO_BROWSER_AUTOMATION=unavailable`인 macOS 실행 환경에서는 Chrome을 직접 실행하지 않습니다. macOS 앱 등록/Mach 서비스 등록 거부가 시스템 충돌 알림을 만듭니다. CHROME_PATH·CHROME_BIN·PUPPETEER_EXECUTABLE_PATH를 존중하며, `/Applications/Google Chrome.app`을 하드코딩하거나 다른 플래그로 반복 실행하지 않습니다. 실행 가능한 CI 또는 신뢰된 검증 환경에서 브라우저 검사를 수행하고, 수행하지 못한 검사는 성공으로 기록하지 않습니다. 개인 프로필·시스템 충돌 알림 설정·샌드박스 권한을 변경하여 해결하지 않습니다.

CodeMemo의 온라인 쓰기 턴에서는 `codememo-browser request.json`으로 별도 검증 서비스를 사용할 수 있습니다. 프로젝트 개발 서버를 먼저 실행하고 요청 파일에 `url`(예: http://127.0.0.1:4173), `actions`(click/type/wait/text 및 selector), `screenshot: true`를 적습니다. 결과는 JSON, 스크린샷은 요청 파일명 뒤 `.png`로 반환됩니다. 이 서비스는 임시 브라우저 프로필을 사용하며 임의 셸·JavaScript 실행 기능은 제공하지 않습니다. CODEMEMO_BROWSER_TOKEN을 출력하거나 파일·로그에 저장하지 않습니다. 기존 전체 브라우저 테스트와 이 제한된 검사를 구분하여 기록합니다.

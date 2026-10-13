# HTMLMemo 실행 탭의 GitHub Pages 연결 수정 패치

**현재 상태: 수정 패치와 로컬 검증 완료, CodeMemo 원본에는 미적용.**

`HTMLMemo-pages-run.patch`는 CodeMemo 실행 탭의 `브라우저에서 열기`와 `링크 복사`가 `https://seionwon.github.io/HTMLMemo/`를 사용하도록 수정합니다. 이전에 저장한 localhost 주소와 static/app 분류보다 Pages 주소를 우선합니다. 앱 유형이나 웹 진입 파일의 비동기 감지가 끝나기 전에도 실행 버튼을 표시합니다.

HTMLMemo 프로젝트에서는 수동 공개 URL 편집, 프로젝트 유형 재검사, 앱 배포 ZIP 및 로컬 실행 명령 표시를 숨깁니다. 이미 실행 중인 명령이 있으면 중단할 수 있도록 해당 명령의 제어 화면은 유지합니다. 올바른 주소와 앱 유형은 프로젝트 메타데이터에도 저장합니다. 다른 이름의 프로젝트는 기존 실행 동작을 유지합니다.

이 코드는 HTMLMemo PWA의 내부 실행 화면이 아니라 **CodeMemo의 실행 탭**을 대상으로 합니다. 현재 허용된 쓰기 위치는 HTMLMemo 프로젝트 폴더뿐이므로 CodeMemo 소스를 직접 수정하지 않았습니다. CodeMemo 소스 프로젝트를 쓰기 가능한 작업 대상으로 열고 해당 패치를 적용해야 실제 화면이 변경됩니다. GitHub Pages에 HTMLMemo 앱 소스를 올리는 것만으로 CodeMemo 실행 탭의 동작은 바뀌지 않습니다.

대상 파일: `apps/CodeMemo/src/components/Project/ProjectConsole.tsx`

검증: 전체 대상 파일의 TSX 문법 변환, 실제 RunPanel 클릭 핸들러의 16가지 DOM 구조·상태 모델 검사, 적용 위치 확인. HTMLMemo 상대·절대·Windows 폴더 경로, 이전 localhost 주소, static/app/미분류 상태, Pages 열기·복사, 클립보드 권한 실패, 불필요한 입력·ZIP UI 제거, 프로젝트 메타데이터 복구, 다른 프로젝트의 기존 실행을 확인했습니다. 실제 CodeMemo 빌드·배포·화면 클릭 검증은 수행하지 않았습니다.

패치 재생성: `python3 codememo-integration/prepare-pages-run-patch.py`

검증 실행: `node codememo-integration/verify-pages-run.mjs`

두 도구는 이 작업 환경에서 확인한 읽기 전용 CodeMemo 소스 및 TypeScript 경로를 사용합니다. 생성한 검증용 소스 사본은 `/tmp/`에만 기록합니다. 소스 파일이나 프로젝트 설정을 자동으로 수정하는 명령은 포함하지 않습니다.

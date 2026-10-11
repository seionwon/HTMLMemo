# CodeMemo 실행 탭의 배포 ZIP 표시 수정안

## 현재 상태

첨부 화면은 HTMLMemo 앱 내부 화면이 아니라 CodeMemo 본체의 실행 탭입니다. 기존 CodeMemo는 실행 로그를 TXT로 내보내고 APK 다운로드를 표시하지만, HTMLMemo의 Pages ZIP을 실행 탭에 표시하는 연결은 없습니다.

이 폴더의 수정안은 **아직 CodeMemo 본체에 적용하지 않았습니다**. 현재 세션에서 쓰기 가능한 프로젝트는 HTMLMemo이고, CodeMemo 본체인 `/Users/ls/workspace/MemoSuite`는 읽기만 가능합니다. HTMLMemo 앱 코드나 생성된 배포 ZIP을 바꿔도 이 본체 화면은 바뀌지 않습니다.

## 적용할 동작

CodeMemo의 실행 탭 상단에서 현재 프로젝트의 `dist/downloads/`에 있는 `*-pages.zip` 파일을 확인합니다. HTMLMemo에서는 `HTMLMemo-pages.zip` 파일 이름과 **배포 ZIP 다운로드** 링크를 표시합니다. 실행 로그나 기존 웹 프로젝트 분류가 없어도 표시됩니다.

파일 하나에 대한 기존 CodeMemo 다운로드 API를 사용합니다. 클릭할 때마다 내려받기 주소를 요청하고 브라우저가 파일을 받습니다. HTMLMemo의 저장소 전체를 ZIP으로 만들거나 GitHub에 업로드하지 않습니다. 같은 위치의 Chrome 확장 ZIP과 기타 ZIP은 이 목록에 표시하지 않습니다.

처음 열 때, 빌드 상태가 바뀔 때, 창에 돌아올 때와 10초마다 파일 목록을 확인합니다. 빌드 결과가 새로 생기거나 삭제되면 목록을 갱신합니다. 읽기 권한이 거절되면 자동 요청을 중단하고 오류를 표시합니다. 다운로드가 실패하면 오류를 표시하고 사용자가 링크를 다시 누를 수 있습니다.

## 적용 대상과 방법

`CodeMemo-run-zip.patch`는 아래 두 파일만 변경하는 패치입니다.

- `apps/CodeMemo/src/components/Project/RunDeploymentZip.tsx` 추가
- `apps/CodeMemo/src/components/Project/ProjectConsole.tsx`의 실행 화면에 해당 컴포넌트 연결

CodeMemo 본체를 수정 가능한 프로젝트로 열어 이 패치를 적용하고, 본체의 관련 검사와 빌드·운영 반영을 수행해야 실제 화면에 표시됩니다. 본체의 다른 변경과 기존 이력을 보존하며, 적용 후 본체 이력에는 실제 검증·반영 상태를 기록해야 합니다. 이 HTMLMemo 프로젝트의 기능 이력에는 미적용 본체 변경을 완료된 기능으로 기록하지 않았습니다.

본체 작업 환경에서 사용할 명령은 다음과 같습니다. 이 세션에서는 두 번째 적용 명령을 실행하지 않았습니다.

```sh
git apply --check /Users/ls/MemoSuite/code-projects/u1/CodeMemo/HTMLMemo/codememo-integration/CodeMemo-run-zip.patch
git apply /Users/ls/MemoSuite/code-projects/u1/CodeMemo/HTMLMemo/codememo-integration/CodeMemo-run-zip.patch
```

## 검증

`node --test codememo-integration/verify.mjs`로 수정 컴포넌트의 실제 React 코드와 DOM 모델을 검사합니다. CodeMemo의 설치된 React·TypeScript를 읽기만 하며 다른 위치에서는 `MEMOSUITE_ROOT`로 본체 경로를 지정합니다. 새 패키지를 설치하지 않습니다.

5개 검사에서 ZIP 표시와 파일 이름, 현재 프로젝트의 다운로드 API 호출, 새 다운로드 요청, 빌드 파일 추가·삭제 감지, 무관한 ZIP과 잘못된 경로 제외, 실패 후 재시도, 권한 거절 후 자동 요청 중단을 확인했습니다. TypeScript 타입 검사와 본체에 연결할 JSX 문법 검사도 통과했습니다. 현재 본체 소스에 대한 `git apply --check`도 통과했습니다. 이 명령은 실제 파일을 수정하지 않습니다.

실제 CodeMemo 화면·로그인 API·운영 배포는 검증하지 않았습니다. 현재 배포 ZIP은 `dist/downloads/HTMLMemo-pages.zip`에 있으며 CodeMemo의 **파일 탭 → dist → downloads**에서도 찾을 수 있습니다.

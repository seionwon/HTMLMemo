# HTMLMemo 작업 지침

## GitHub Pages 게시

- 이 프로젝트의 저장소는 `seionwon/HTMLMemo`, 브랜치는 `main`, 게시 주소는 `https://seionwon.github.io/HTMLMemo/`입니다. 다른 MemoSuite 프로젝트의 GitHub 계정과 혼동하지 않습니다.
- 현재 저장소의 origin URL과 credential username을 사용합니다. 전역 `gh auth switch`, 토큰을 포함한 원격 URL, 자격 증명 출력으로 인증을 바꾸지 않습니다. 토큰·개인 문서·기기 설정을 소스나 빌드에 넣지 않습니다.
- 사용자가 게시를 요청했으면 소스 검사·빌드·필요한 실제 Chrome 검사, 관련 파일만 커밋, `git push origin main`, 해당 커밋의 GitHub Actions·Pages 게시 성공, 온라인 파일과 화면 확인까지 진행합니다. 로컬 빌드만 완료한 상태를 배포 완료로 표현하지 않습니다.
- 기존 `.github/workflows/deploy-pages.yml`이 main push 뒤 검사·빌드·게시를 수행합니다. 게시 소스는 GitHub Actions이며 dist만 공개됩니다. 이미 정상인 Source 설정을 다시 바꾸거나 별도 공개 서버를 만들지 않습니다.
- 연결 오류가 나면 현재 환경에서 저장소 접근과 GitHub API를 다시 확인하고 GitHub 응답, 인증 실패, 명령 실행 환경의 네트워크 제한을 구분합니다. 이전 대화나 이력의 접속 오류만으로 현재 연결도 차단되어 있다고 판단하지 않습니다.
- `listen EPERM`은 해당 실행 환경에서 localhost 실행이 제한됐다는 근거이며 GitHub 장애의 근거가 아닙니다. Chrome 검사는 별도 임시 프로필을 사용하고 사용자의 실제 브라우저 프로필을 사용하지 않습니다.
- 실행 환경이 네트워크를 막는다면 설정된 권한을 임의로 우회하지 않습니다. CodeMemo의 기존 게시 기능 등 이미 허용된 배포 경로에서 게시를 이어갑니다. 환경의 권한 변경과 GitHub 자체 장애를 구분해 기록합니다.

## 검증과 기록

`npm run check`, `npm test`, `npm run build`로 검사합니다. 문서 화면·파일 저장·리더 동작을 바꾸면 가능한 환경에서 `npm run test:browser`로 실제 Chrome 동작을 확인합니다. 실행하지 못한 검사를 통과했다고 쓰지 않습니다.

사용자에게 영향을 주는 변경과 운영 반영 결과는 `docs/기능 추가 history.md`에 한국어로 기록합니다. 이전 실패 기록을 삭제하지 말고 같은 항목에 실제 후속 검증·게시 결과를 보충합니다. 다른 작업의 변경과 `codememo-integration/`의 미적용 패치는 자동으로 커밋하지 않습니다.

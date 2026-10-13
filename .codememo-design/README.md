# HTMLMemo 디자인

현재 디자인과 새 시안을 CodeMemo의 디자인 탭에서 비교합니다. 선택만으로 실행 중인 앱은 바뀌지 않습니다. 적용을 누르면 에이전트가 실제 코드·아이콘·빌드·배포에 반영합니다.

- Tailwind CSS / CLI: **4.3.3**. CDN 없이 로컬에서 컴파일합니다.
- 첫 시안과 첫 색상·아이콘은 현재 모습의 기준입니다. 원본 스타일 참고 자료는 git에서 제외한 original-snapshot.json에 보관합니다. 복원 시 최근 기능 코드를 지우지 않습니다.
- 디자인 요청의 개인 기록은 이 프로젝트에 저장하지 않습니다. 서버의 비공개 저장소에 보관합니다.
- 새 웹 디자인은 CSS-first @theme와 반응형 Tailwind 유틸리티를 사용합니다. 초기 전환에서는 Preflight를 적용하지 않아 기존 화면을 유지합니다.
- 스타일 수정은 base.tailwind.css에서 하고 node .codememo-design/build.mjs로 다시 컴파일합니다. npm install --prefix .codememo-design 후에는 다른 개발 환경에서도 빌드할 수 있습니다.

## 적용 완료 기준

JSON/CSS 시안 파일만 만든 것은 완료가 아닙니다. 선택을 실제 진입 파일과 아이콘에 통합하고 빌드·적절한 검사를 수행하며 배포 결과를 확인한 뒤 receipt-<작업 ID>.json을 작성합니다. 소스가 실제 변경되고 이번 작업의 빌드 산출물이 있어야 CodeMemo가 적용됨으로 표시합니다.

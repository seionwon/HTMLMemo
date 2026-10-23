# MemoSuite TTS 이식 원본

- UI: `packages/shared/src/components/MemoReadAloud.tsx`
- 독립 HTML 브라우저 엔진: `packages/shared/src/components/readAloudRuntime.ts`
- 한국어 문구: `packages/shared/src/i18n/locales/ko.ts`
- 원본 날짜: 2026-10-14

툴바와 패널의 스타일 선언·버튼 순서·아이콘을 MemoReadAloud에서 가져왔습니다. TTS 버튼은 재생하지 않고 툴바만 열고 닫습니다. 문장 분할, 수식 발음, 음성 필터, 문장 이동, 일시정지·재개는 독립 HTML 런타임에서 이식했습니다. HTMLMemo의 iframe 확대·스크롤 좌표, 문서 수명, 전체 화면, 파일 배포 구조에만 연결부를 추가했습니다. 서버 API가 없는 GitHub Pages에서는 브라우저 음성을 사용하며 MemoSuite의 서버/Piper/복제 음성을 사용할 수 있다고 표시하지 않습니다.

가져오는 HTML에는 TTS 기능이 없다는 전제로, 상단 TTS 버튼과 낭독 툴바는 HTMLMemo가 제공합니다. 책 안의 TTS 버튼을 탐지하거나 기존 재생 이벤트를 가로채는 호환 코드는 사용하지 않습니다. 툴바의 ▶ 버튼을 눌러야 읽기를 시작하며, HTML 내보내기에는 앱의 읽기 버튼이나 음성 기능을 삽입하지 않습니다.

원본 SHA256:
- `MemoReadAloud.tsx`: `537c4f3aa39cafaef21a021500fa3c36532f1bec22f403559ed4ef3bec98036c`
- `readAloudRuntime.ts`: `e9f845ac2bb4296e4c9f920956c8af4e0ecc59f2246666b040b9511653a60406`

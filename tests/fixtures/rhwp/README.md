# rhwp 읽기 전용 참조 샘플

rhwp v0.8.7의 공개 회귀 검사 파일을 변경 없이 보관합니다. 개인 사용자 파일은 포함하지 않습니다. 라이선스는 upstream MIT이며 `public/vendor/office/rhwp/LICENSE`에 원문을 보관합니다.

- `legacy.hwp`: `samples/hwp3-ellipse-empty-textbox.hwp` — 구형 HWP의 타원·빈 글상자·문자.
- `reference.hwpx`: `samples/hwpx/ref/ref_text.hwpx` — 한국어와 영문, 숫자.
- `formatting.hml`: `samples/hml/formatting_table.hml` — 표·글상자·생략 경고.

출처: https://github.com/edwardkim/rhwp/tree/v0.8.7

별도의 `tests/hangul-fixtures.mjs`는 직접 만든 HML 문장과 표를 HWP/HWPX로도 만들어 원본 바이트·가져오기·주석·내보내기·폴더 복원을 비교합니다. 원본 생성용 쓰기 API는 테스트에서만 사용합니다.

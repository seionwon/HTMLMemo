# LibreMemo 포맷 공통 UI 검증

최종 확인: 2026-11-01 04:52:57 +09:00. **[공개 앱](https://seionwon.github.io/LibreMemo/) 1.7.1**, 소스 `b90cfe45dbb85b56cce832d941a2d9f58d97b162`. [GitHub Actions 41233315353](https://github.com/seionwon/LibreMemo/actions/runs/41233315353)의 build·deploy·verify가 모두 성공한 결과다.

- 로컬: 단위 856개 통과, JavaScript·JSON 205개(무시된 로컬 검증 도구 포함), 빌드·diff 검사 통과.
- Actions Linux: 단위 856개 중 855개 통과·macOS 전용 검사 1개 건너뛰기, JavaScript·JSON 186개 통과.
- 전체 소스 Chrome: 113개 통과(부모 검사 2개, JUnit leaf 111개), 공개 주소 Chrome: 79개 통과. 실패·취소·건너뛰기 없음.
- 실제 Linux Pages 산출물과 공개 자산 294개·49,681,372바이트가 HTTP 200·전체 바이트·SHA-256까지 일치.

[최종 요약](validation.json), [Actions 상세](ci.json), [로컬 검사](local-validation.json), [소스 JUnit](browser-results.xml), [공개 JUnit](published-browser-results.xml), [공개 자산 대조](public-files.json)에 원자료를 남겼다. `source-chrome-summary-1.7.0.txt`는 이전 1.7.0 성공의 보존 기록이며 최종 결과는 1.7.1이다.

## 비교 범위

[34개 확장자](pages-only-format-parity.json)에서 1280·390·320px의 읽기 도구·사이드바, 화면 모드·글씨 크기·주석·북마크·TTS를 비교했다. [책과 공통 사이드바](pages-only-format-parity-sidebar.json)는 원래 일반 링크형 목차 행·보기 탭·검색창 두 개·북마크 버튼의 실제 스타일을 대조한다. 책의 도구와 사이드바는 25·50·100·125·200% × 3개 창 크기의 15개 조합에서 크기·위치·클릭 가능 상태를 확인했다.

[실제 책 검색 1280px](pages-only-book-search-ui-scale-1280.json)와 [390px](pages-only-book-search-ui-scale-390.json)는 25·200·100%에서 결과 행의 크기와 사이드바 시작 위치를 비교한다. [계층 목차·가로 표 검색](pages-only-format-parity-navigation.json)에서는 접힘 보존·제목 이동과 내부 스크롤 0 → 1,782px 후 검색어의 실제 가시성을 확인했다. [확대 수치](pages-only-zoom-sync.json), [붙여넣기 읽기 도구](pages-only-pasted-reading.json), [PDF 오프라인](pages-only-pdf-security-offline.json)도 공개 Chrome의 기록이다.

## 대표 공개 화면

[HTML 320px](pages-only-format-parity-html-320.png) · [PDF 320px](pages-only-format-parity-pdf-320.png) · [HWPX 320px](pages-only-format-parity-hwpx-320.png) · [DOCX 320px](pages-only-format-parity-docx-320.png) · [EPUB 320px](pages-only-format-parity-epub-320.png) · [원래 목차 1280px](pages-only-format-parity-native-outline-1280.png) · [원래 도구줄 1280px](pages-only-copied-source-toolbar-1280.png) · [표 검색](pages-only-format-parity-search.png) · [책 검색 390px](book-search-results-390.png) · [휴대폰 단어·문장 선택](sidebar-views-text-clicks-390-normal.png).

## 한계

실제 Chrome의 새 임시 프로필과 합성 문서로 검증했다. 작은 화면은 기기 크기 에뮬레이션이며 실물 Android 검사는 하지 않았다. 샌드박스에서 데스크톱 Chrome을 직접 실행하지 않았다. 본문은 원본의 서식·고정 쪽 구조·텍스트 유무를 유지한다. 그림만 있는 문서는 텍스트 층 없이 검색·선택·TTS를 제공할 수 없으며, OCR·DRM 해제·원본 편집 기능을 추가한 작업은 아니다.

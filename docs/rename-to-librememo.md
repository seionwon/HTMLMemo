# LibreMemo 이름 변경과 GitHub 저장소 전환

HTMLMemo의 새 제품 이름은 **LibreMemo**입니다. 앱 제목·PWA 설치 이름·설정·도움말·내보내기 제안 이름·디자인 시안과 Chrome 연결의 표기를 바꿉니다. 기능과 문서 데이터는 같은 앱으로 이어집니다.

## 저장소 이름은 언제 바꾸나요?

**이름 변경 버전을 기존 `seionwon/HTMLMemo` 저장소에서 먼저 게시하고 확인한 뒤** 바꿉니다. 기존 주소는 `https://seionwon.github.io/HTMLMemo/`, 변경 후 주소는 `https://seionwon.github.io/LibreMemo/`입니다. 전환 전에 새 주소가 이미 작동한다고 안내하지 않습니다.

1. 기존 저장소의 **Settings → General → Repository name**을 **LibreMemo**로 바꾸고 **Rename**을 누릅니다.
2. 이름이 바뀐 저장소의 **Actions → Deploy LibreMemo to GitHub Pages → Run workflow**에서 **main**으로 실행합니다. **build · deploy · verify**가 모두 성공해야 전환 완료입니다. 게시 검사는 Actions의 실제 Pages 출력 주소를 사용하므로 저장소 이름을 다시 하드코딩할 필요가 없습니다.
3. 로컬 원격 주소를 갱신합니다. CodeMemo 프로젝트의 실제 폴더는 대화 기록과 연결돼 있으므로 그대로 둡니다.

   ```sh
   git -C /Users/ls/MemoSuite/code-projects/u1/CodeMemo/HTMLMemo remote set-url origin https://seionwon@github.com/seionwon/LibreMemo.git
   ```

4. 새 주소를 Chrome에서 열고 서재·주석·휴지통·설정을 확인합니다. 즐겨찾기와 다른 사람에게 공유한 주소도 새 주소로 바꿉니다. 설치된 아이콘이 옛 주소를 계속 열면 새 주소에서 설치 정보를 갱신하거나 아이콘을 다시 설치합니다. **Chrome의 사이트 데이터나 전용 저장 폴더를 지우는 절차는 필요하지 않습니다.**

GitHub는 저장소의 Git 주소를 리디렉션하지만 프로젝트 Pages 주소의 리디렉션은 보장하지 않습니다. [GitHub 공식 이름 변경 안내](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)를 참고하세요. 예전 이름으로 다른 저장소를 새로 만들면 Git 주소 리디렉션도 끊어집니다.

## 기존 데이터와 이름이 남는 이유

- 두 Pages 주소는 `https://seionwon.github.io`라는 같은 출처입니다. 같은 기기·같은 Chrome 프로필에서는 기존 IndexedDB, 로컬 설정, 폴더 연결 정보를 계속 사용합니다. 별도 기기·다른 브라우저 프로필로 데이터가 자동 이동한다는 뜻은 아닙니다.
- `HTMLMemo-v1` 등 데이터베이스 이름, `htmlmemo-*` 설정 키, 주석의 HTML 속성, PDF 공유 파일 표식, 저장 폴더의 관리 파일 이름과 동기화 규약은 호환 식별자입니다. 기존 문서·백업·다른 기기와의 호환성을 위해 유지합니다. 파일 관리자로 개별 이름을 바꾸지 마세요.
- 새 저장 폴더의 기본 제안 이름은 **LibreMemo**입니다. 기존 **HTMLMemo** 폴더나 사용자가 붙인 다른 이름의 폴더를 그대로 연결해도 됩니다. 프로젝트 소스 폴더 이름도 이번 전환에서 강제로 옮기지 않습니다.
- PWA의 설치 식별자는 이전 `./`를 옛 공개 주소에서 해석한 `/HTMLMemo/`로 고정해 앱 이름 변경만으로 새 앱 식별자를 만들지 않습니다. 아이콘에 표시되는 앱 이름은 **LibreMemo**입니다. 기존 설치의 시작 주소를 브라우저가 언제 갱신하는지는 별도로 확인해야 합니다.
- 앱에서 **URL 복사**로 공유하는 주소와 폴더 안내문은 실제로 열린 옛 주소·새 주소를 따릅니다. CodeMemo도 새 주소의 LibreMemo manifest를 확인한 뒤 실행 링크를 새 주소로 전환하며, 게시 전·오프라인·실패 때는 기존 주소를 유지합니다.

## 백업과 확인

전용 폴더 상태가 **폴더 자동 저장 완료**인지 확인하고 중요한 자료가 있으면 폴더 전체를 복사해 보관하세요. 이름 변경을 위해 문서를 다시 가져오거나 데이터를 초기화하지 않습니다. 한 문서를 HTML로 내보내는 것은 서재 전체·휴지통·설정·이력의 백업과 다릅니다.

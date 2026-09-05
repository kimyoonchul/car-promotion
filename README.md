# bmw-campaign-tracker

BMW 공식 딜러사 7곳(코오롱·도이치·한독·동성·삼천리·바바리안·내쇼날)의 정비 캠페인을 매일 자동 수집해서, **구글 시트**에 비교 테이블로 쌓고 **디스코드**로 신규 캠페인을 알려주는 도구.

```
GitHub Actions (매일 09:30 KST)
 └→ 딜러 7곳 캠페인 페이지 수집 (fetch + cheerio)
     └→ 신규 게시물 감지 (data/state.json diff)
         └→ 배너 이미지에서 기간·할인·무료혜택 추출 (Claude 비전, structured outputs)
             ├→ 구글 시트 "지금 진행중" 탭: 딜러당 1행 비교표 (매번 덮어씀, D-day 표시)
             ├→ 구글 시트 "전체 로그" 탭: 신규 캠페인 이력 축적
             ├→ 디스코드: 신규 캠페인 알림 (건별)
             └→ 디스코드: 요약 다이제스트 (매주 월요일 또는 --digest 플래그)
```

딜러사들이 캠페인 상세(기간·할인율)를 배너 **이미지**로만 올리기 때문에, 텍스트 파싱만으로는 제목·게시일까지만 나온다. 기간·혜택은 Claude 비전으로 이미지에서 추출한다.

## 로컬 실행

```sh
npm install
npm run dry-run          # 수집·추출만 하고 시트/디스코드/상태 저장은 생략
node src/index.js --no-vision --dry-run   # 이미지 추출도 생략 (API 키 불필요)
npm run collect          # 실제 실행
node src/index.js --digest   # 실행 + "지금 진행중" 요약을 디스코드로 발송
```

`.env.example`을 `.env`로 복사해서 채우면 로컬에서도 전체 파이프라인이 돈다. 채우지 않은 항목은 해당 단계만 조용히 생략된다.

## 배포 (GitHub Actions)

1. 이 폴더를 GitHub 레포로 푸시
2. 레포 Settings → Secrets and variables → Actions 에 등록:
   - `ANTHROPIC_API_KEY` — [console.anthropic.com](https://console.anthropic.com)에서 발급
   - `DISCORD_WEBHOOK_URL` — 디스코드 채널 설정 → 연동 → 웹후크 만들기
   - `GOOGLE_SHEET_ID` — 시트 URL의 `/d/`와 `/edit` 사이 문자열
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — GCP 서비스 계정 키 JSON 전체 내용
3. 구글 시트를 서비스 계정 이메일(`...@...iam.gserviceaccount.com`)에 **편집자**로 공유
4. Actions 탭에서 `collect-campaigns` 워크플로를 수동 실행(workflow_dispatch)해서 첫 수집 확인

첫 실행은 백필이라 디스코드 알림 없이 시트에만 쌓인다. 이후 실행부터 신규 캠페인만 알림이 온다. `data/state.json`(수집 이력)은 액션이 자동 커밋한다.

## 드라이빙 센터 예약 자리 알림

BMW 드라이빙 센터 **Owners Track Day**(자가 차량 서킷 주행, 50,000원)는 거의 항상 매진이라, 취소표·추가 오픈을 잡기 위해 10분마다 잔여석을 확인해 같은 디스코드 채널로 알린다.

```
GitHub Actions (10분마다)
 └→ /api/public/schedule 로 이번 달~3개월 뒤까지 회차가 있는 날짜 조회
     └→ 날짜별 /api/public/schedule/YYYYMMDD 로 회차별 잔여석 조회
         └→ data/driving-center.json 과 비교
             ├→ 잔여석 0 → 1 이상으로 바뀐 회차 → 디스코드 "자리 났어요" 알림 (@here)
             └→ 처음 보는 날짜 → "새 일정 오픈" 알림
```

- 예약 페이지는 BMW ID 로그인 + 가상 대기열 뒤에 있지만, 일정 API는 로그인 없이 응답해서 **아이디·비밀번호·쿠키가 필요 없다** (2026-09 확인)
- 자리가 계속 있는 회차는 다시 알리지 않고, 다시 매진된 뒤 또 열리면 다시 알린다
- 감시 프로그램 추가는 `src/drivingCenter.js`의 `PROGRAMS`에 한 줄 (Owners Drift Day 코드가 주석으로 있음)

```sh
npm run watch-dc -- --dry-run   # 조회·비교만
npm run watch-dc:status         # 현재 예약 현황을 디스코드로 한 번 발송 (웹훅 확인용)
npm run watch-dc                # 실제 실행 (변화 있으면 알림 + 상태 저장)
```

## 구조

| 파일 | 역할 |
|---|---|
| `src/dealers.js` | 딜러별 수집 소스 정의 (URL·파싱 방식). 딜러 추가/변경은 여기만 |
| `src/scrape.js` | 공용 CMS 파서 (아카이브 목록 / 허브 페이지 / 메뉴 / sitemap) |
| `src/vision.js` | Claude 비전으로 배너 이미지에서 기간·혜택 JSON 추출 |
| `src/sheets.js` / `src/discord.js` | 구글 시트 append / 디스코드 embed 알림 |
| `src/state.js` + `data/state.json` | 이미 본 게시물 기록 (신규 감지용) |

## 알아둘 것

- 전 딜러가 robots.txt 크롤링 허용 상태이고 하루 1회 폴링이라 부담 없음 (2026-07 확인)
- 코오롱모터스 서버는 간헐적으로 다른 딜러 콘텐츠를 응답하는 버그가 있어 응답 본문 검증 + 재시도를 넣어둠
- BMW코리아 공식 사이트(bmw.co.kr)는 Akamai 봇 차단이 있어 v1에서 제외 (공식 캠페인은 전국 공통이라 갱신도 드묾)
- 딜러들은 카카오톡 채널·인스타그램에도 병행 공지함 — v2 후보

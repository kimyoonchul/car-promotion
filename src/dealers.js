// BMW 공식 딜러사별 수집 소스 정의 (2026-07 사전조사 기준)
//
// 모든 딜러 사이트가 동일한 공용 CMS(bmwdealeradmin.co.kr) 기반 서버렌더링이라 파서를 공유한다.
// source.kind:
//   - hub:     고정 URL에 최신 캠페인 1건이 게시되는 페이지 (h1 + "published on:" + 배너 이미지)
//   - archive: 연도별 목록 페이지 (a.blog-post-title 앵커 목록), url은 (year) => string
//   - menu:    홈페이지 메가메뉴에서 /promotions/{uuid} 앵커를 수집 (코오롱: 별도 목록 페이지 없음)
//   - sitemap: sitemap.xml의 /promotions/ URL diff (바바리안)
//
// source.service: true면 "정비/A·S 캠페인" 소스. "지금 진행중" 요약은 이 표시가 있는
// 소스 중 가장 최근 게시물을 우선 고른다 — 표시가 없으면(이벤트·금융프로모션·공지)
// 최근 게시일이 더 빨라도 요약에서 밀려난다.

export const DEALERS = [
  {
    key: 'deutsch',
    name: '도이치모터스',
    regions: '서울·성남·강원·제주',
    sources: [
      { kind: 'hub', category: '이달의 A/S 캠페인', service: true, url: () => 'https://www.deutschmotors.com/promotions/6415b09b-345d-486b-a789-fab8d68fd812' },
      { kind: 'archive', category: 'A/S 캠페인', service: true, url: (y) => `https://www.deutschmotors.com/promotions/previous/c0ababa2-aa8e-4011-83f4-d04bc2b31c0b--${y}` },
      { kind: 'hub', category: '뉴스&이벤트', url: () => 'https://www.deutschmotors.com/promotions/f60357d0-0913-438f-9957-500693fd467e' },
    ],
  },
  {
    key: 'handok',
    name: '한독모터스',
    regions: '서울·수원·대구·광주',
    sources: [
      { kind: 'hub', category: '캠페인', service: true, url: () => 'https://www.bmwhandok.co.kr/promotions/50fcf97e-e5e7-4c54-b0e1-3dfe7c42429b' },
    ],
  },
  {
    key: 'dongsung',
    name: '동성모터스',
    regions: '부산·울산·경북·경남',
    sources: [
      { kind: 'hub', category: 'A/S 프로모션', service: true, url: () => 'https://www.bmwdongsung.co.kr/promotions/b09f9902-1b3a-40d2-82d1-66a8f4b49b76' },
      { kind: 'archive', category: 'A/S 캠페인', service: true, url: (y) => `https://www.bmwdongsung.co.kr/promotions/previous/a9ce62f6-1947-4db1-b451-e31c0a6247aa--${y}` },
      { kind: 'hub', category: '이달의 이벤트', url: () => 'https://www.bmwdongsung.co.kr/promotions/eaf7abcd-3141-4c3f-b713-c7bc319e86da' },
    ],
  },
  {
    key: 'samchully',
    name: '삼천리모터스',
    regions: '경기·세종·충북·충남',
    sources: [
      { kind: 'hub', category: '서비스 캠페인', service: true, url: () => 'https://www.samchullymotors.co.kr/promotions/f37a0c1d-3c57-47d4-9007-413771de0b83' },
      { kind: 'archive', category: '서비스 캠페인', service: true, url: (y) => `https://www.samchullymotors.co.kr/promotions/previous/6eb74784-286d-48f1-af91-e6b2142e010f--${y}` },
    ],
  },
  {
    key: 'bavarian',
    name: '바바리안모터스',
    regions: '서울 금천·인천·일산',
    sources: [
      { kind: 'hub', category: 'A/S 프로모션', service: true, url: () => 'https://www.bavarian.co.kr/promotions/297c5a2a-11f7-4220-bb85-6a5dabce8637' },
      { kind: 'sitemap', category: '프로모션', url: () => 'https://www.bavarian.co.kr/sitemap.xml' },
    ],
  },
  {
    key: 'national',
    name: '내쇼날모터스',
    regions: '평택·안성·충남·군산·목포',
    sources: [
      { kind: 'archive', category: 'A/S 캠페인', service: true, url: (y) => `https://www.nationalmotors.co.kr/promotions/previous/46b5103b-481b-4e0f-b6e0-61a3141ad443--${y}` },
    ],
  },
  {
    key: 'kolon',
    name: '코오롱모터스',
    regions: '서울·부산·대구·대전·광주 등 전국',
    // 서버가 간헐적으로 같은 CMS의 타 딜러 콘텐츠를 응답하는 사례가 확인됨
    validate: (html) => html.includes('코오롱'),
    sources: [
      { kind: 'menu', category: '소식', url: () => 'https://www.kolonmotors.com/' },
    ],
  },
];

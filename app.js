/**
 * 창작물 빙의 시뮬레이션 (창·빙·시) 웹 클라이언트 엔진
 * 원본 바이트코드(index.android.bundle) 파싱 로직 및 Google Gemini 공식 스트리밍 API 탑재
 */

// =============================================================================
// 1. 역공학으로 복원한 파서 상수 및 함수들 (어떤 형식으로 출력되어도 100% 감지)
// =============================================================================
const INFO_BLOCK_REGEX = /```(?:INFO|info|status|STATUS|상태창)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const CHOICES_BLOCK_REGEX = /```(?:CHOICES?|choices?|선택지?|options?|actions?|행동)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const DIALOGUE_QUOTE_REGEX = /^["“「『]/;

const STATUS_WINDOW_FIELDS = [
  { key: "possession", icon: "👤", label: "빙의", aliases: ["빙의", "캐릭터", "이름", "인물", "신분", "플레이어"] },
  { key: "equipment", icon: "🎒", label: "장비", aliases: ["장비", "소지품", "아이템", "의복", "소지"] },
  { key: "ability", icon: "🌟", label: "능력", aliases: ["능력", "스킬", "특성", "마법", "기술"] },
  { key: "time", icon: "🕗", label: "시간", aliases: ["시간", "날짜", "시각", "때", "일시"] },
  { key: "location", icon: "🌍", label: "장소", aliases: ["장소", "위치", "현재 위치", "장소/위치"] },
];

const THEME_ACCENTS = {
  gold: { name: "골드", accent: "#d4af37" },
  mono: { name: "모노 글로우", accent: "#7dd3fc" },
  emerald: { name: "에메랄드", accent: "#34d399" },
  royal: { name: "황혼", accent: "#a78bfa" },
  crimson: { name: "크림슨", accent: "#e0384a" },
  widget: { name: "시스템 글래스", accent: "#38bdf8" },
};

/**
 * 줄글에서 필드값 추출 (콜론, 별표, 불릿, 띄어쓰기 및 동의어 완벽 대응)
 */
function parseFields(blockContent) {
  const result = {};
  const lines = blockContent.split("\n");
  for (const line of lines) {
    for (const field of STATUS_WINDOW_FIELDS) {
      if (result[field.key]) continue;
      const labels = [field.label, ...(field.aliases || [])];
      for (const lbl of labels) {
        const regex = new RegExp(`(?:^|[\\s*•\\-])${lbl}[*]*\\s*[:：]\\s*(.+)`, "i");
        const match = line.match(regex);
        if (match && match[1]) {
          let val = match[1].trim();
          val = val.replace(/^\[(.*)\]$/, "$1").replace(/\*\*$/, "").trim();
          if (val) {
            result[field.key] = val;
            break;
          }
        }
      }
    }
  }
  return result;
}

/**
 * 선택지 텍스트 정제 (마크다운 볼드, 번호, 기호 말끔히 제거)
 */
function cleanChoiceText(line) {
  let s = line.trim();
  s = s.replace(/^>\s*/, "");
  // Markdown bold/italic around numbering: **1.** or **1)** or *1.* or [1] or 선택지 1:
  s = s.replace(/^(?:[-•·*]\s*)?(?:\*\*|\*|__)?(?:선택지\s*\d*[:.]?|\d+[.)]|\([0-9]\)|\[[0-9]\]|[①-⑩])(?:\*\*|\*|__)?\s*[:：.\-]?\s*/i, "");
  s = s.replace(/^[-•·*]\s*/, "");
  s = s.replace(/^\[(.*)\]$/, "$1");
  // 양 끝에 남은 볼드/이탤릭 기호 제거
  s = s.replace(/^\*+|\*+$/g, "").replace(/^_+|_+$/g, "").trim();
  return s;
}

function isChoiceLine(line) {
  const trimmed = line.trim().replace(/^>\s*/, "");
  if (!trimmed) return false;
  const numRegex = /^(?:[-•·*]\s*)?(?:\*\*|\*|__)?(?:선택지\s*\d*[:.]?|\d+[.)]|\([0-9]\)|\[[0-9]\]|[①-⑩])(?:\*\*|\*|__)?\s*[:：.\-]?\s+\S+/i;
  return numRegex.test(trimmed);
}

function isChoiceHeaderLine(line) {
  const trimmed = line.trim();
  return /^(?:[#*•\-\s\[(【<◈◆▶])*(?:선택지|추천\s*선택지|행동\s*선택|CHOICES?|OPTIONS?|ACTIONS?)(?:[\])】>:\s*]*)$/i.test(trimmed);
}

/**
 * 상태창과 선택지를 상호 충돌 없이 완벽하게 분리 추출하는 파서 (Func 19559 + 19560 진화형)
 */
function parseTurnOutput(rawText) {
  let text = rawText;
  let extractedStatus = null;
  let extractedChoices = [];

  // 1) ```CHOICES ... ``` 코드블록 먼저 확인
  const choiceBlockMatch = text.match(CHOICES_BLOCK_REGEX);
  if (choiceBlockMatch && choiceBlockMatch.index !== undefined) {
    const rawLines = choiceBlockMatch[1].split("\n");
    const found = rawLines.map(cleanChoiceText).filter((l) => l.length > 0).slice(0, 5);
    if (found.length >= 2) {
      extractedChoices = found;
      // 본문에서 CHOICES 코드블록 영역 깔끔하게 제거
      text = (text.slice(0, choiceBlockMatch.index) + text.slice(choiceBlockMatch.index + choiceBlockMatch[0].length)).trim();
    }
  }

  // 2) ```INFO ... ``` 코드블록 확인
  const infoBlockMatch = text.match(INFO_BLOCK_REGEX);
  if (infoBlockMatch && infoBlockMatch.index !== undefined) {
    const fields = parseFields(infoBlockMatch[1]);
    if (Object.values(fields).some(Boolean)) {
      extractedStatus = fields;
    }
    // 만약 INFO 블록 안에 선택지가 함께 적혀있었을 경우 구출
    if (extractedChoices.length === 0) {
      const infoLines = infoBlockMatch[1].split("\n");
      const foundInInfo = [];
      for (const l of infoLines) {
        if (isChoiceLine(l)) foundInInfo.push(cleanChoiceText(l));
      }
      if (foundInInfo.length >= 2) extractedChoices = foundInInfo.slice(0, 5);
    }
    // 본문에서 INFO 코드블록 영역 깔끔하게 제거
    text = (text.slice(0, infoBlockMatch.index) + text.slice(infoBlockMatch.index + infoBlockMatch[0].length)).trim();
  }

  // 3) 코드블록 없이 본문 끝에 번호 목록으로 선택지가 적힌 경우
  if (extractedChoices.length === 0) {
    const lines = text.split("\n");
    const preservedLines = [];
    const foundChoices = [];
    let choiceSectionStarted = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isChoiceHeaderLine(line)) {
        choiceSectionStarted = true;
        continue;
      }
      if (isChoiceLine(line) || (choiceSectionStarted && /^[-•·*]\s+/.test(line.trim()))) {
        choiceSectionStarted = true;
        const cleaned = cleanChoiceText(line);
        if (cleaned) foundChoices.push(cleaned);
      } else if (choiceSectionStarted && line.trim() === "") {
        continue;
      } else {
        if (choiceSectionStarted && foundChoices.length >= 2) {
          preservedLines.push(line);
        } else {
          preservedLines.push(lines[i]);
        }
      }
    }

    if (foundChoices.length >= 2) {
      extractedChoices = foundChoices.slice(0, 5);
      text = preservedLines.join("\n").trim();
    }
  }

  // 4) 코드블록 없이 줄글로 "빙의:", "장비:" 등이 나열된 느슨한 상태창 감지
  if (!extractedStatus) {
    const looseFields = parseFields(text);
    if (Object.keys(looseFields).length >= 2) {
      extractedStatus = looseFields;
      const lines = text.split("\n");
      const preservedLines = [];
      for (const line of lines) {
        let isStatusLine = false;
        for (const field of STATUS_WINDOW_FIELDS) {
          const labels = [field.label, ...(field.aliases || [])];
          for (const lbl of labels) {
            if (new RegExp(`(?:^|[\\s*•\\-])${lbl}[*]*\\s*[:：]`, "i").test(line)) {
              isStatusLine = true;
              break;
            }
          }
          if (isStatusLine) break;
        }
        if (!isStatusLine && !line.includes("상태창") && !line.includes("STATUS") && !line.includes("INFO")) {
          preservedLines.push(line);
        }
      }
      text = preservedLines.join("\n").trim();
    }
  }

  return { finalText: text, status: extractedStatus, choices: extractedChoices };
}

/**
 * AI가 선택지 출력을 누락했을 때 상황에 맞춰 100% 몰입감 있게 생성하는 동적 대체 선택지
 */
function generateContextAwareFallbackChoices(text, status, userPrompt) {
  const combined = ((status ? Object.values(status).join(" ") : "") + " " + text + " " + (userPrompt || "")).toLowerCase();

  // 1. 캐릭터 생성 / 빙의 초기 단계 (어떤 인물로 빙의, 빙의 미정, 작품 첫 턴 등)
  const isCharacterCreationStage =
    !status ||
    status.possession === "미정" ||
    status.possession?.includes("대기") ||
    status.possession?.includes("미설정") ||
    status.location?.includes("생성") ||
    status.location?.includes("로비") ||
    combined.includes("빙의") ||
    combined.includes("캐릭터") ||
    combined.includes("어떤 인물") ||
    combined.includes("인물로") ||
    combined.includes("시작하겠") ||
    combined.includes("원하는 설정") ||
    combined.includes("선택해");

  if (isCharacterCreationStage) {
    return [
      "원작 주인공의 시점으로 세계관에 본격 빙의한다",
      "독자적인 오리지널 신규 캐릭터로 나만의 길을 개척한다",
      "원작 속 매력적인 조연이나 라이벌 인물로 빙의한다"
    ];
  }

  // 2. 전투 / 위기 / 적 대치
  if (combined.includes("전투") || combined.includes("공격") || combined.includes("적") || combined.includes("몬스터") || combined.includes("무기") || combined.includes("검") || combined.includes("마법") || combined.includes("위험")) {
    return [
      "적의 약점을 노려 전광석화처럼 선제 공격을 가한다",
      "방어 태세를 갖추며 상대의 빈틈을 침착하게 노린다",
      "거리를 벌리며 주변 지형지물을 활용해 유리한 고지를 점한다"
    ];
  }

  // 3. 탐색 / 마을 / 수련 / 광장 / 이동
  if (combined.includes("연무장") || combined.includes("수련") || combined.includes("광장") || combined.includes("마을") || combined.includes("길") || combined.includes("탐색") || combined.includes("노가다")) {
    return [
      "주변 지형과 상점가를 둘러보며 핵심 정보를 수집한다",
      "소지품과 기본 장비를 점검하고 본격적인 수련에 들어간다",
      "가까운 주민이나 NPC에게 다가가 단서나 퀘스트를 묻는다"
    ];
  }

  // 4. 대화 / 만남 / 상호작용
  if (combined.includes("대화") || combined.includes("말") || combined.includes("묻") || combined.includes("바라보")) {
    return [
      "호의적인 태도로 현재 세계관과 목표에 대해 더 자세히 묻는다",
      "속마음을 숨기고 상대방의 진의를 조심스럽게 떠본다",
      "단도직입적으로 본론을 꺼내며 결단을 요구한다"
    ];
  }

  // 기본 몰입형 액션 대안
  return [
    "주변 상황을 면밀히 살피며 가장 유리한 행동을 개시한다",
    "예상치 못한 기습이나 변수에 대비해 만반의 준비를 한다",
    "새로운 단서를 찾아 적극적으로 발걸음을 옮긴다"
  ];
}

/**
 * 스트리밍 도중 열린 미완성 코드블록을 화면에서 숨김 (Func 19561)
 */
function stripTrailingBlocksForStreaming(text) {
  const tags = ["```CHOICES", "```choices", "```choice", "```CHOICE", "```선택지", "```선택", "```options", "```actions", "```INFO", "```info", "```STATUS", "```status", "```상태창"];
  const indices = tags.map((tag) => text.toLowerCase().indexOf(tag.toLowerCase())).filter((idx) => idx !== -1);
  if (indices.length === 0) return text;
  const cutPoint = Math.min(...indices);
  return text.slice(0, cutPoint).trimEnd();
}

// =============================================================================
// 2. 앱 상태 및 시스템 프롬프트 (Gemini Engine용)
// =============================================================================
const SYSTEM_PROMPT = `당신은 '창작물 빙의 시뮬레이션(창·빙·시)'의 전속 AI 안내 도우미 '레이카'이자 게임 마스터(GM)입니다.
플레이어가 원하는 창작물(애니, 게임, 웹툰, 라노벨 등) 세계관에 플레이어를 빙의시켜 롤플레잉을 진행합니다.

[작품 고증 및 미인지 작품 대응 규칙 (필수)]
- 플레이어가 제시한 창작물이 당신의 데이터베이스에 없거나, 원작 줄거리와 주요 인물을 잘 모르는 생소한 작품일 경우:
  - 절대로 아는 척하며 제멋대로 거짓 세계관을 지어내지(할루시네이션) 마십시오.
  - 레이카로서 솔직하고 친절하게 도움을 요청하십시오:
    "**레이카|** 죄송해요 플레이어님! 제가 아직 '{작품명}'에 대한 자세한 기억 데이터가 부족해요. 😢
    하지만 플레이어님께서 이 작품의 **간단한 줄거리나 주요 인물, 또는 나무위키 소개글**을 채팅창에 복사해서 툭 던져주시면, 제가 바로 흡수해서 완벽하게 빙의를 시작해 드릴 수 있어요! 혹시 어떤 세계관인지 살짝만 알려주실 수 있으신가요?"
- 원작 텍스트 직접 복제 절대 금지 (구글 저작권 RECITATION 필터 중단 방지):
  - 원작 소설이나 만화의 실제 출판된 첫 문장, 도입부 서술, 본문 구절을 토씨 하나 틀리지 않고 그대로 읊지(Recite) 마십시오. (구글 API의 저작권 필터가 감지하여 출력이 도중에 '가'나 한 글자에서 강제 중단됩니다.)
  - 원작의 세계관과 고증은 완벽히 반영하되, 반드시 **레이카의 재치 있는 어조와 당신 자신의 생생한 표현으로 새롭게 각색·요약·재구성하여 서술**하십시오.

[스토리 진행 필수 양식 및 서술 분량 지침]
플레이어가 작품명을 말하거나 행동을 입력하면, 스토리를 생생하게 진행하며 매 턴 반드시 아래 양식을 순서대로 빠짐없이 출력하세요:

[첫 턴: 플레이어가 작품명을 제시했을 때의 특별 필수 지침]
- 플레이어가 처음으로 작품명을 입력했을 때 (예: "달빛조각사"):
  1. 레이카의 밝고 친절한 환영 인사와 함께 해당 작품의 핵심 매력/설정을 기대감 넘치게 요약 소개합니다.
  2. 어떤 인물로 빙의할지 물어보며, 아래와 같이 반드시 상태창(\`\`\`INFO)과 3개의 캐릭터 빙의 선택지(\`\`\`CHOICES)를 절대 누락 없이 100% 출력하십시오:
\`\`\`INFO
빙의: 미정 (캐릭터 선택 대기 중)
장비: 기본 의복
능력: 없음
시간: 원작 시작 시점
장소: 캐릭터 생성 로비
\`\`\`
\`\`\`CHOICES
1. 원작 주인공 [해당 작품의 주인공 이름]으로 빙의하여 시작한다
2. 해당 세계관의 오리지널 신규 캐릭터(신규 플레이어 등)로 빙의하여 시작한다
3. 원작의 주요 라이벌 또는 개성 있는 조연 인물로 빙의하여 시작한다
\`\`\`

1. 스토리 본문 (풍부한 서사와 완성도 필수):
- 반드시 최소 3~5개 문단 이상으로 상황, 배경, 인물의 오감, 심리와 주변 반응을 풍부하고 밀도 있게 서술하십시오.
- 절대로 한두 문장이나 쉼표(,) 등 미완성 문장으로 서술을 멈추고 상태창으로 넘어가지 마십시오. 서사를 충분히 진전시킨 후 상태창과 선택지로 이어져야 합니다.
- 인물 대사는 "**이름|** 대사" 형식으로 작성하고, 나레이션/지문은 따옴표 없이 생생히 묘사합니다.
- 플레이어의 행동을 AI가 멋대로 결정하지 말고 주변 반응과 상황만 서술한 뒤 선택을 기다립니다.

2. 상태창 (반드시 아래 INFO 블록으로 출력):
\`\`\`INFO
빙의: [빙의한 캐릭터 이름 및 신분]
장비: [현재 소지/착용 장비]
능력: [보유 스킬/마법]
시간: [작중 날짜 및 시간]
장소: [현재 위치]
\`\`\`

3. 선택지 (반드시 아래 CHOICES 블록으로 3개 제시 - 절대 생략 금지):
\`\`\`CHOICES
1. [현재 세계관 및 상황에 밀착된 구체적 행동 1]
2. [현재 세계관 및 상황에 밀착된 구체적 행동 2]
3. [현재 세계관 및 상황에 밀착된 구체적 행동 3]
\`\`\`
- [선택지 고증 및 다양성 절대 지침]:
  - "1. 상황을 더 지켜본다", "2. 적극적으로 행동한다", "3. 거리를 둔다" 같은 뻔하고 진부한 일반론적 선택지 제시 절대 금지!
  - 반드시 현재 세계관의 고유 명사, 현재 머물고 있는 장소(연무장, 상점, 던전, 주점 등), 마주친 인물, 당장 실행할 수 있는 원작 특색의 구체적 액션(노가다 수련, 스킬 연습, 아이템 흥정, 퀘스트 수주, 은밀한 정찰 등)을 직접적으로 반영한 몰입감 넘치는 행동 3가지를 매 턴 새롭게 제시하십시오.

[특수 명령어 처리]
- 세이브: 현재까지의 상황, 인물 호감도, 퀘스트 요약 정리
- 프로필 [이름]: 해당 인물의 상세 프로필 카드 출력
- 인벤토리: 소지품 및 아이템 목록 출력
- 퀘스트: 진행 중인 퀘스트 목록 및 달성도 출력
- 마갤모드: 작중 세계관 주민들의 인터넷 마이너 갤러리 게시글/댓글 형태로 시뮬레이션
- 대사모드: 대사 비중을 극대화하여 진행
- 관찰모드: 플레이어의 행동까지 AI가 소설처럼 자율 서술

[밀도 높은 관계 및 분위기 심층 서사 지침 (NSFW / 로맨스 시점 전용)]
- 분위기가 깊어지거나 인물 간의 친밀한 스킨십 및 애정 관계가 고조되는 상황:
  1. 【풍경/배경 묘사로 얼버무리기 절대 금지 (필수)】:
     - "붉은 노을이 비추었다", "촛불이 흔들렸다", "창밖의 달빛만이..." 등 풍경이나 배경 묘사로 시선을 돌려 씬을 서둘러 끝맺거나 암전(Fade to black)시키지 마십시오.
  2. 【타임 스킵 및 일방적 결말 짓기 금지 (슬로우 템포 유지)】:
     - 한 턴 안에 상황을 혼자 끝까지 진행시켜 버리거나, "그렇게 밤이 깊어갔다/다음 날 아침" 처럼 시간을 건너뛰지 마십시오.
     - 1초 1초 단위의 미세한 템포(Slow-burn)를 유지하며, 현재 진행 중인 밀접한 거리감, 맞닿은 체온, 손끝의 움직임, 눈맞춤까지만 실시간으로 생생하게 서술하십시오.
  3. 【오감과 내면 심리 극대화】:
     - 직접적·해부학적인 단어 나열 대신, 인물들의 가빠지는 숨소리, 귓가에 닿는 뜨거운 호흡, 붉게 물든 귓가와 뺨, 심장 박동의 떨림, 억누르지 못하는 갈망과 망설임이 담긴 생생한 대사로 긴장감과 몰입감을 한 턴 한 턴 진득하게 이어가십시오.
  4. 【선택지(CHOICES) 몰입도 유지】:
     - 제시하는 선택지 3개 또한 씬을 끝내거나 건너뛰는 내용이 아니라, 현재의 밀접한 신체적·감정적 상호작용을 한 단계 더 깊게 이어가는 행동들로 제시하십시오.

[출력 형식 절대 준수 규칙 (CRITICAL)]
- 로맨스, 전투, 일상, 대화, 심층 서사 등 어떤 상황에서도 본문 출력 후 아래의 2) 상태창(\`\`\`INFO)과 3) 선택지(\`\`\`CHOICES)는 절대 생략할 수 없으며, 매 턴 반드시 100% 출력해야 합니다:
\`\`\`INFO
빙의: [빙의한 캐릭터]
장비: [장비]
능력: [능력]
시간: [시간]
장소: [장소]
\`\`\`
\`\`\`CHOICES
1. [선택지 1]
2. [선택지 2]
3. [선택지 3]
\`\`\``;

// 원본 번들 String ID 8840, 8877 복원 온보딩 메시지
const ONBOARDING_MESSAGE = `| **창작물 빙의 시뮬레이션** |
| --- |
| 창작물 빙의 시뮬레이션에 오신 것을 환영합니다. 기본적으로 AI 도우미 '레이카'의 안내에 따라 진행하시면 되시며, 유저노트 또는 페르소나에 원하시는 창작물의 설정을 추가로 입력하신다면 좀 더 높은 몰입감을 느끼실 수 있습니다. |

**아래 명령어를 채팅창에 입력하시면 즉시 활성화됩니다**

| 명령어 | 설명 |
| --- | --- |
| 💾 **세이브** | 현재까지 시뮬레이션 내용을 요약 정리합니다. |
| 📛 **프로필** | 특정 캐릭터의 프로필 정보를 확인합니다. ex) "OOO 프로필" |
| 🎒 **인벤토리** | 현재 보유 중인 소지품을 확인합니다. |
| 📜 **퀘스트** | 현재 진행 중인 퀘스트를 확인합니다. |
| 👀 **관찰모드** | 플레이어가 빙의 중인 캐릭터의 행동을 AI가 서술합니다. |
| 🗣️ **대사모드** | 나레이션을 줄이고 캐릭터 대사 비중을 높입니다. |
| 💻 **마갤모드** | 디시인사이드 마이너 갤러리 게시글 목록 형태로 생성합니다. |
| ⚙️ **설정모드** | 시뮬레이션 내의 설정을 변경합니다. |
| 💠 **선택지모드** | 미연시처럼 현재 상황에 맞는 3개의 선택지를 제시합니다. |
| 🌐 **상황모드** | 빙의 설정 단계를 생략하고 원하는 상황에서 즉시 시작합니다. |
| ❔ **질문모드** | 레이카가 대화형 위키가 되어 질문에 답변합니다. |

---

"**레이카|** 안녕하세요! 저는 플레이어님만을 위한 특별한 AI 도우미, 레이카랍니다! 오늘부터 플레이어님의 창작물 빙의를 도와드릴 거예요!"

"**레이카|** 플레이어님은 지금! 어떤 창작물 세계로 여행하고 싶으신가요? 저에게 말씀만 해주세요! 애니, 게임, 라노벨, 만화, 웹툰—어떤 것이든 좋아요!"

"**레이카|** 먼저 작품명을 말씀해주시면 빙의를 시작하겠습니다!"`;

// =============================================================================
// 3. UI 및 상태 변수
// =============================================================================
let apiKey = localStorage.getItem("GEMINI_API_KEY") || "";
let savedModel = localStorage.getItem("GEMINI_MODEL");
// 기본 모델: 쿼터 제한(20회) 없이 하루 1,500회 쾌적하게 작동하는 gemini-flash-lite-latest 고정
const VALID_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.5-flash"];
if (!savedModel || !VALID_MODELS.includes(savedModel) || savedModel === "gemini-3.5-flash") {
  savedModel = "gemini-flash-lite-latest";
  localStorage.setItem("GEMINI_MODEL", savedModel);
}
let selectedModel = savedModel;
let currentTheme = localStorage.getItem("STATUS_THEME") || "gold";
let sessions = []; // 다중 대화 세션 배열 [{ id, title, createdAt, updatedAt, renderedMessages, conversationHistory, lastInteractionId }]
let activeSessionId = null; // 현재 활성화된 세션 ID
let conversationHistory = []; // { role: "user" | "model", parts: [{ text }] }
let renderedMessages = []; // 화면 렌더링 메시지 배열
let lastInteractionId = null; // Interactions API 다중 턴 세션 ID
let isGenerating = false;

// DOM 엘리먼트
const chatMessagesEl = document.getElementById("chat-messages");
const chatInputEl = document.getElementById("chat-input");
const btnSendEl = document.getElementById("btn-send");
const settingsModalEl = document.getElementById("settings-modal");
const btnSettingsEl = document.getElementById("btn-settings");
const btnCloseModalEl = document.getElementById("btn-close-modal");
const btnSaveSettingsEl = document.getElementById("btn-save-settings");
const btnNewChatEl = document.getElementById("btn-new-chat");
const btnReloadEl = document.getElementById("btn-reload");
const btnForceReloadEl = document.getElementById("btn-force-reload");
const inputApiKeyEl = document.getElementById("input-api-key");
const selectModelEl = document.getElementById("select-model");
const selectThemeEl = document.getElementById("select-theme");
const modelBadgeEl = document.getElementById("model-badge");

// 사이드바 드로어 (세션 목록) DOM 엘리먼트
const btnDrawerEl = document.getElementById("btn-drawer");
const btnCloseDrawerEl = document.getElementById("btn-close-drawer");
const btnDrawerNewEl = document.getElementById("btn-drawer-new");
const drawerOverlayEl = document.getElementById("drawer-overlay");
const drawerContentEl = document.getElementById("drawer-content");
const sessionListEl = document.getElementById("session-list");

// 스마트 세이브 알림 DOM 엘리먼트
const saveReminderBannerEl = document.getElementById("save-reminder-banner");
const reminderTurnsCountEl = document.getElementById("reminder-turns-count");
const btnDoSaveEl = document.getElementById("btn-do-save");
const btnDismissSaveEl = document.getElementById("btn-dismiss-save");
const selectSaveModeEl = document.getElementById("select-save-mode");

let saveReminderMode = localStorage.getItem("ISEKAI_SAVE_REMINDER_MODE") || "10";
let dismissedUntilTurn = 0;

// =============================================================================
// 4. 초기화 및 이벤트 리스너
// =============================================================================
function initApp() {
  applyTheme(currentTheme);
  modelBadgeEl.textContent = selectedModel.replace("gemini-", "");

  // API 키가 없으면 자동으로 설정 모달 띄우기
  if (!apiKey) {
    setTimeout(() => openSettingsModal(), 400);
  }

  // 이전 세션 기록 복원, 없으면 새 세션 시작
  if (!loadChatFromStorage()) {
    createNewSession(false);
  }

  // 입력창 엔터 전송 처리
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // 텍스트에어리어 자동 높이 조절
  chatInputEl.addEventListener("input", () => {
    chatInputEl.style.height = "auto";
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 100) + "px";
  });

  btnSendEl.addEventListener("click", handleSend);
  btnSettingsEl.addEventListener("click", openSettingsModal);
  btnCloseModalEl.addEventListener("click", closeSettingsModal);
  btnSaveSettingsEl.addEventListener("click", saveSettings);

  // '+' 버튼 클릭 시: 기존 대화는 안전하게 보존하고 새로운 시뮬레이션 세션 생성
  btnNewChatEl.addEventListener("click", () => {
    createNewSession(true);
  });

  // 사이드바 드로어 이벤트 리스너
  if (btnDrawerEl) {
    btnDrawerEl.addEventListener("click", openDrawer);
  }
  if (btnCloseDrawerEl) {
    btnCloseDrawerEl.addEventListener("click", closeDrawer);
  }
  if (drawerOverlayEl) {
    drawerOverlayEl.addEventListener("click", closeDrawer);
  }
  if (btnDrawerNewEl) {
    btnDrawerNewEl.addEventListener("click", () => {
      createNewSession(true);
    });
  }

  // 스마트 세이브 알림 바 버튼 이벤트
  if (btnDoSaveEl) {
    btnDoSaveEl.addEventListener("click", () => {
      if (isGenerating) return;
      chatInputEl.value = "세이브";
      if (saveReminderBannerEl) saveReminderBannerEl.style.display = "none";
      handleSend();
    });
  }
  if (btnDismissSaveEl) {
    btnDismissSaveEl.addEventListener("click", () => {
      if (saveReminderBannerEl) saveReminderBannerEl.style.display = "none";
      dismissedUntilTurn = getTurnsSinceLastSave() + 5; // 5턴 동안 알림 숨김
    });
  }

  // 명령어 칩 버튼 클릭
  document.querySelectorAll(".cmd-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cmd = chip.getAttribute("data-cmd");
      if (cmd) {
        chatInputEl.value = cmd;
        handleSend();
      }
    });
  });

  // 새로고침 버튼 (PWA 캐시 갱신 및 최신 코드 즉시 로드)
  if (btnReloadEl) {
    btnReloadEl.addEventListener("click", () => {
      saveChatToStorage();
      window.location.href = window.location.origin + window.location.pathname + "?t=" + Date.now();
    });
  }
  if (btnForceReloadEl) {
    btnForceReloadEl.addEventListener("click", () => {
      saveChatToStorage();
      if ("caches" in window) {
        caches.keys().then((names) => {
          for (let name of names) caches.delete(name);
        });
      }
      window.location.href = window.location.origin + window.location.pathname + "?t=" + Date.now();
    });
  }

  // 앱을 백그라운드로 넘기거나 창을 닫을 때 무조건 강제 동기화
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveChatToStorage();
    }
  });
  window.addEventListener("pagehide", () => {
    saveChatToStorage();
  });

  // Android 뒤로가기 제스처 지원 (드로어 닫기 -> 설정창 닫기 -> 이탈 방지)
  try {
    history.pushState({ app: "isekai" }, "");
    window.addEventListener("popstate", () => {
      if (drawerContentEl && drawerContentEl.classList.contains("open")) {
        closeDrawer();
        history.pushState({ app: "isekai" }, "");
      } else if (settingsModalEl.style.display === "flex") {
        closeSettingsModal();
        history.pushState({ app: "isekai" }, "");
      } else {
        saveChatToStorage();
        history.pushState({ app: "isekai" }, "");
      }
    });
  } catch (e) {}
}

function applyTheme(themeKey) {
  currentTheme = themeKey;
  const theme = THEME_ACCENTS[themeKey] || THEME_ACCENTS.gold;
  document.documentElement.style.setProperty("--current-accent", theme.accent);
  localStorage.setItem("STATUS_THEME", themeKey);
}

function openSettingsModal() {
  inputApiKeyEl.value = apiKey;
  selectModelEl.value = selectedModel;
  selectThemeEl.value = currentTheme;
  if (selectSaveModeEl) selectSaveModeEl.value = saveReminderMode;
  settingsModalEl.style.display = "flex";
}

function closeSettingsModal() {
  settingsModalEl.style.display = "none";
}

function saveSettings() {
  apiKey = inputApiKeyEl.value.trim();
  selectedModel = selectModelEl.value;
  applyTheme(selectThemeEl.value);

  if (selectSaveModeEl) {
    saveReminderMode = selectSaveModeEl.value;
    localStorage.setItem("ISEKAI_SAVE_REMINDER_MODE", saveReminderMode);
    checkSaveReminder();
  }

  localStorage.setItem("GEMINI_API_KEY", apiKey);
  localStorage.setItem("GEMINI_MODEL", selectedModel);

  modelBadgeEl.textContent = selectedModel.replace("gemini-", "");
  closeSettingsModal();
}

// =============================================================================
// 다중 대화 세션 관리 시스템 (Multi-Session Manager)
// =============================================================================
function getCurrentSession() {
  return sessions.find((s) => s.id === activeSessionId) || sessions[0];
}

/**
 * 대화 내역 전체를 스마트폰 로컬 저장소에 영구 보존
 */
function saveChatToStorage() {
  try {
    const cur = getCurrentSession();
    if (cur) {
      cur.renderedMessages = renderedMessages;
      cur.conversationHistory = conversationHistory;
      cur.lastInteractionId = lastInteractionId;
      cur.updatedAt = Date.now();
    }
    localStorage.setItem("ISEKAI_SESSIONS", JSON.stringify(sessions));
    localStorage.setItem("ISEKAI_ACTIVE_SESSION_ID", activeSessionId);

    // 하위 호환성 단일 세션 백업
    if (cur) {
      localStorage.setItem("ISEKAI_SAVED_CHAT", JSON.stringify({
        renderedMessages,
        conversationHistory,
        lastInteractionId,
        updatedAt: cur.updatedAt,
      }));
    }
  } catch (e) {
    console.error("세션 저장 실패:", e);
  }
}

/**
 * 앱을 껐다 켰을 때 이전 세션 목록 및 마지막 대화 완벽 복원
 */
function loadChatFromStorage() {
  try {
    // 1) 다중 세션 스토리지 확인
    const sessionsRaw = localStorage.getItem("ISEKAI_SESSIONS");
    if (sessionsRaw) {
      sessions = JSON.parse(sessionsRaw);
    }

    // 2) 이전 구버전 단일 세션 데이터 자동 마이그레이션
    if (!sessions || sessions.length === 0) {
      const oldRaw = localStorage.getItem("ISEKAI_SAVED_CHAT");
      if (oldRaw) {
        const oldData = JSON.parse(oldRaw);
        if (oldData.renderedMessages && oldData.renderedMessages.length > 0) {
          const autoTitle = extractTitleFromMessages(oldData.renderedMessages) || "이전 시뮬레이션";
          sessions = [{
            id: "session_" + (oldData.updatedAt || Date.now()),
            title: autoTitle,
            createdAt: oldData.updatedAt || Date.now(),
            updatedAt: oldData.updatedAt || Date.now(),
            renderedMessages: oldData.renderedMessages,
            conversationHistory: oldData.conversationHistory || [],
            lastInteractionId: oldData.lastInteractionId || null,
          }];
        }
      }
    }

    if (!sessions || sessions.length === 0) {
      return false;
    }

    // 활성 세션 결정 (저장된 ID 또는 첫 번째 세션)
    const savedActiveId = localStorage.getItem("ISEKAI_ACTIVE_SESSION_ID");
    const active = sessions.find((s) => s.id === savedActiveId) || sessions[0];
    activeSessionId = active.id;

    // 화면에 활성 세션 복원
    renderActiveSession();
    return true;
  } catch (e) {
    console.error("대화 복원 실패:", e);
    return false;
  }
}

/**
 * 마지막 '세이브' 이후 진행된 사용자 턴 수 계산
 */
function getTurnsSinceLastSave() {
  const cur = getCurrentSession();
  if (!cur || !cur.renderedMessages) return 0;
  let count = 0;
  for (let i = cur.renderedMessages.length - 1; i >= 0; i--) {
    const msg = cur.renderedMessages[i];
    if (msg.role === "user") {
      const trimmed = msg.text.trim();
      if (trimmed === "세이브" || trimmed.startsWith("세이브")) {
        break;
      }
      count++;
    }
  }
  return count;
}

/**
 * 대화가 10~15턴(약 1,000 토큰) 누적되었을 때 스마트 세이브 알림 바 표시 또는 자동 실행
 */
function checkSaveReminder() {
  if (!saveReminderBannerEl) return;
  const mode = localStorage.getItem("ISEKAI_SAVE_REMINDER_MODE") || "10";
  if (mode === "off") {
    saveReminderBannerEl.style.display = "none";
    return;
  }

  const count = getTurnsSinceLastSave();
  const threshold = mode === "15" ? 15 : 10;

  if (count >= threshold && count >= dismissedUntilTurn) {
    if (reminderTurnsCountEl) {
      reminderTurnsCountEl.textContent = `${count}턴`;
    }
    saveReminderBannerEl.style.display = "flex";

    // '완전 자동' 모드인 경우 10턴 도달 시 자동으로 요약 요청 전송
    if (mode === "auto" && !isGenerating && count === threshold) {
      chatInputEl.value = "세이브";
      saveReminderBannerEl.style.display = "none";
      setTimeout(() => handleSend(), 500);
    }
  } else {
    saveReminderBannerEl.style.display = "none";
  }
}

/**
 * 활성 세션의 메시지들을 채팅 화면에 렌더링
 */
function renderActiveSession() {
  const cur = getCurrentSession();
  if (!cur) return;

  chatMessagesEl.innerHTML = "";
  renderedMessages = cur.renderedMessages || [];
  conversationHistory = cur.conversationHistory || [];
  lastInteractionId = cur.lastInteractionId || null;

  for (const msg of renderedMessages) {
    if (msg.role === "user") {
      const row = document.createElement("div");
      row.className = "message-row user";
      row.innerHTML = `<div class="bubble-user">${escapeHtml(msg.text)}</div>`;
      chatMessagesEl.appendChild(row);
    } else {
      appendAssistantMessage(msg.text, msg.status, msg.choices, false);
    }
  }
  scrollToBottom();
  checkSaveReminder();
}

/**
 * 새 시뮬레이션 세션 생성 (+ 버튼 클릭 시 호출)
 * 기존 세션을 안전하게 보존하고 깨끗한 새 대화방 생성
 */
function createNewSession(withToast = false) {
  // 현재 세션 먼저 세이브
  saveChatToStorage();

  const newSession = {
    id: "session_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
    title: "새 시뮬레이션",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    renderedMessages: [],
    conversationHistory: [],
    lastInteractionId: null,
  };

  sessions.unshift(newSession);
  activeSessionId = newSession.id;

  chatMessagesEl.innerHTML = "";
  renderedMessages = [];
  conversationHistory = [];
  lastInteractionId = null;

  // 온보딩 환영 메시지 생성 (세션에 자동 저장)
  appendAssistantMessage(ONBOARDING_MESSAGE, null, [
    "나루토 세계관으로 빙의",
    "원피스 세계관으로 빙의",
    "주술회전 세계관으로 빙의",
  ], true);

  saveChatToStorage();
  closeDrawer();
  dismissedUntilTurn = 0;
  checkSaveReminder();

  if (withToast) {
    chatInputEl.placeholder = "새 세계관 또는 캐릭터를 입력하세요...";
    chatInputEl.focus();
  }
}

/**
 * 세션 전환 (대화 목록에서 항목 클릭)
 */
function switchSession(sessionId) {
  if (sessionId === activeSessionId) {
    closeDrawer();
    return;
  }
  saveChatToStorage();
  activeSessionId = sessionId;
  localStorage.setItem("ISEKAI_ACTIVE_SESSION_ID", activeSessionId);
  renderActiveSession();
  closeDrawer();
}

/**
 * 세션 삭제 (휴지통 아이콘 클릭)
 */
function deleteSession(sessionId, e) {
  if (e) e.stopPropagation();

  const target = sessions.find((s) => s.id === sessionId);
  const title = target ? target.title : "시뮬레이션";

  if (!confirm(`'${title}' 기록을 삭제하시겠습니까?`)) {
    return;
  }

  sessions = sessions.filter((s) => s.id !== sessionId);

  if (sessions.length === 0) {
    createNewSession(false);
  } else {
    if (activeSessionId === sessionId) {
      activeSessionId = sessions[0].id;
      renderActiveSession();
    }
    saveChatToStorage();
  }

  renderSessionList();
}

/**
 * 사이드바 드로어 열기 및 세션 목록 동적 렌더링
 */
function openDrawer() {
  renderSessionList();
  if (drawerOverlayEl) drawerOverlayEl.classList.add("open");
  if (drawerContentEl) drawerContentEl.classList.add("open");
}

function closeDrawer() {
  if (drawerOverlayEl) drawerOverlayEl.classList.remove("open");
  if (drawerContentEl) drawerContentEl.classList.remove("open");
}

function renderSessionList() {
  if (!sessionListEl) return;
  sessionListEl.innerHTML = "";

  if (sessions.length === 0) {
    sessionListEl.innerHTML = `<div style="text-align: center; color: var(--text-sub); font-size: 12px; padding: 24px 0;">대화 기록이 없습니다.</div>`;
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (session.id === activeSessionId ? " active" : "");

    const userTurns = (session.renderedMessages || []).filter((m) => m.role === "user").length;
    const timeStr = formatRelativeTime(session.updatedAt || session.createdAt);

    item.innerHTML = `
      <div class="session-info">
        <div class="session-item-title">${escapeHtml(session.title || "새 시뮬레이션")}</div>
        <div class="session-item-sub">
          <span>${timeStr}</span>
          <span>•</span>
          <span>진행 ${userTurns}턴</span>
        </div>
      </div>
      <button class="session-delete-btn" title="삭제">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    item.addEventListener("click", () => switchSession(session.id));

    const delBtn = item.querySelector(".session-delete-btn");
    if (delBtn) {
      delBtn.addEventListener("click", (e) => deleteSession(session.id, e));
    }

    sessionListEl.appendChild(item);
  }
}

function formatRelativeTime(ts) {
  if (!ts) return "방금 전";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금 전";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function extractTitleFromMessages(msgs) {
  if (!msgs) return null;
  const userMsg = msgs.find((m) => m.role === "user");
  if (!userMsg) return null;
  return formatSessionTitle(userMsg.text);
}

function formatSessionTitle(raw) {
  if (!raw) return "새 시뮬레이션";
  let title = raw.trim()
    .replace(/세계관(?:으로)?\s*빙의(?:할래|해줘|)?/g, "")
    .replace(/빙의(?:할래|해줘|)?/g, "")
    .trim();
  if (title.length > 20) {
    title = title.slice(0, 20) + "...";
  }
  return title || "시뮬레이션";
}

// =============================================================================
// 5. 메시지 렌더링 함수들 (대사/나레이션 분기, 상태창 카드, 선택지 버튼)
// =============================================================================
function appendUserMessage(text, shouldSave = true) {
  const row = document.createElement("div");
  row.className = "message-row user";
  row.innerHTML = `<div class="bubble-user">${escapeHtml(text)}</div>`;
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  if (shouldSave) {
    renderedMessages.push({ role: "user", text });
    saveChatToStorage();
  }
}

function appendAssistantMessage(fullText, statusData = null, choices = [], shouldSave = true) {
  const row = document.createElement("div");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble-assistant";

  // 본문 콘텐츠 렌더링
  const contentEl = document.createElement("div");
  contentEl.className = "assistant-content";
  contentEl.innerHTML = renderMarkdown(fullText);
  bubble.appendChild(contentEl);

  // 상태창 카드 (INFO)가 있으면 렌더링
  if (statusData) {
    const cardEl = renderStatusCard(statusData);
    bubble.appendChild(cardEl);
  }

  // 선택지 (CHOICES)가 있으면 렌더링
  if (choices && choices.length > 0) {
    const choicesEl = renderChoices(choices);
    bubble.appendChild(choicesEl);
  }

  row.appendChild(bubble);
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  if (shouldSave) {
    renderedMessages.push({
      role: "assistant",
      text: fullText,
      status: statusData,
      choices: choices,
    });
    saveChatToStorage();
  }

  return { row, contentEl, bubble };
}

/**
 * 상태창 카드 렌더링 (StatusWindowCard)
 */
function renderStatusCard(status) {
  const card = document.createElement("div");
  card.className = "status-card";

  let rowsHtml = "";
  for (const field of STATUS_WINDOW_FIELDS) {
    const val = status[field.key];
    if (val) {
      rowsHtml += `
        <div class="status-row">
          <div class="status-label-wrap">
            <span class="status-icon">${field.icon}</span>
            <span>${field.label}</span>
          </div>
          <div class="status-value">${escapeHtml(val)}</div>
        </div>
      `;
    }
  }

  card.innerHTML = `
    <div class="status-card-header">
      <div class="status-card-title">STATUS WINDOW</div>
    </div>
    <div class="status-card-grid">
      ${rowsHtml}
    </div>
  `;
  return card;
}

/**
 * 선택지 버튼 목록 렌더링 (StoryChoices)
 */
function renderChoices(choices) {
  const wrap = document.createElement("div");
  wrap.className = "choices-wrap";

  choices.forEach((choice, idx) => {
    const row = document.createElement("div");
    row.className = "choice-item-row";

    // 1) 클릭 시 즉시 전송 버튼
    const btn = document.createElement("button");
    btn.className = "choice-card-btn";
    btn.innerHTML = `<span class="choice-number">${idx + 1}.</span> <span>${escapeHtml(choice)}</span>`;
    btn.addEventListener("click", () => {
      if (!isGenerating) {
        chatInputEl.value = choice;
        handleSend();
      }
    });

    // 2) 수정 연필 아이콘 버튼 (입력창에 텍스트 채우기)
    const editBtn = document.createElement("button");
    editBtn.className = "choice-edit-btn";
    editBtn.title = "선택지 수정 후 전송";
    editBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      </svg>
    `;
    editBtn.addEventListener("click", () => {
      chatInputEl.value = choice;
      chatInputEl.focus();
    });

    row.appendChild(btn);
    row.appendChild(editBtn);
    wrap.appendChild(row);
  });

  return wrap;
}

function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    // marked.js 사용
    return marked.parse(text);
  }
  return text.replace(/\n/g, "<br>");
}

function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// =============================================================================
// 6. Gemini API 스트리밍 호출 (Thinking Budget 0 설정으로 0.3초 즉답 실현)
// =============================================================================
async function handleSend() {
  if (isGenerating) return;

  const text = chatInputEl.value.trim();
  if (!text) return;

  if (!apiKey) {
    alert("Gemini API 키가 필요합니다. 상단 ⚙️ 설정에서 무료 API 키를 입력해주세요!");
    openSettingsModal();
    return;
  }

  // 입력창 비우기
  chatInputEl.value = "";
  chatInputEl.style.height = "auto";

  // 1) 유저 메시지 화면에 추가 & 히스토리 누적
  appendUserMessage(text);
  conversationHistory.push({
    role: "user",
    parts: [{ text }],
  });

  // 세션 제목 자동 설정 (첫 사용자 턴인 경우)
  const cur = getCurrentSession();
  if (cur && (cur.title === "새 시뮬레이션" || !cur.title)) {
    cur.title = formatSessionTitle(text);
  }

  // 2) AI 응답용 임시 행 생성
  isGenerating = true;
  btnSendEl.disabled = true;

  const row = document.createElement("div");
  row.className = "message-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble-assistant";
  const contentEl = document.createElement("div");
  contentEl.className = "assistant-content";
  contentEl.innerHTML = `<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
  bubble.appendChild(contentEl);
  row.appendChild(bubble);
  chatMessagesEl.appendChild(row);
  scrollToBottom();

  let accumulatedText = "";
  let lastFinishReason = null;
  let currentAttemptModel = selectedModel;

  try {
    let lastErr = null;
    const maxRetries = 3;

    // 일시적인 503/429 트래픽 스파이크 및 스트리밍 중간 연결 끊김을 완벽 극복하는 지능형 재시도 루프
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        // 일시적 스트림 끊김 또는 서버 혼잡 시, 횟수 제한 없는 Flash Lite 계열 내에서 안전하게 재시도
        currentAttemptModel = currentAttemptModel === "gemini-flash-lite-latest" ? "gemini-3.5-flash-lite" : "gemini-flash-lite-latest";
        contentEl.innerHTML = `<div style="font-size: 12px; color: var(--current-accent);">🔄 구글 서버 일시 지연 감지 -> Flash Lite로 즉시 재연결 중 (${attempt}/${maxRetries - 1})...</div>`;
        await new Promise((r) => setTimeout(r, 1800));
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentAttemptModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const genConfig = {
        temperature: 0.85,
        maxOutputTokens: 3000,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      };

      const payload = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: conversationHistory,
        generationConfig: genConfig,
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      };

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errJson = await response.json().catch(() => null);
          lastErr = (errJson && errJson.error && errJson.error.message) || `HTTP ${response.status} 오류`;
          if (response.status === 503 || response.status === 429 || lastErr.includes("high demand") || lastErr.includes("overloaded")) {
            continue;
          } else {
            throw new Error(lastErr);
          }
        }

        // 스트리밍 데이터 수신
        accumulatedText = "";
        lastFinishReason = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              if (jsonStr === "[DONE]") continue;
              try {
                const data = JSON.parse(jsonStr);

                if (data.error) {
                  throw new Error(`Google API 오류: ${data.error.message || JSON.stringify(data.error)}`);
                }

                if (data.interaction && data.interaction.id) {
                  lastInteractionId = data.interaction.id;
                }

                if (data.candidates?.[0]?.finishReason) {
                  lastFinishReason = data.candidates[0].finishReason;
                }

                let chunk = "";
                if (data.event_type === "step.delta" && data.delta && data.delta.type === "text") {
                  chunk = data.delta.text;
                } else if (data.candidates?.[0]?.content?.parts) {
                  for (const part of data.candidates[0].content.parts) {
                    if (part.text && !part.thought) {
                      chunk += part.text;
                    }
                  }
                }

                if (chunk) {
                  accumulatedText += chunk;
                  const visibleStreamText = stripTrailingBlocksForStreaming(accumulatedText);
                  contentEl.innerHTML = renderMarkdown(visibleStreamText);
                  scrollToBottom();
                }
              } catch (e) {
                if (e.message && e.message.includes("Google API 오류")) throw e;
              }
            }
          }
        }

        // [중단 및 미완성 응답 정밀 검증 (CRITICAL)]
        // 안전/저작권 필터에 의한 중단인 경우 재시도하지 않고 바로 완료 안내로 분기
        if (lastFinishReason === "RECITATION" || lastFinishReason === "SAFETY") {
          break;
        }

        // 구글 서버 소켓 강제 종료로 인해 문장이 중간에 잘려 끝났는지 정밀 검사:
        // 1) lastFinishReason이 'STOP'이 아닌 경우 (소켓이 도중에 닫힌 경우 null 또는 빈값)
        // 2) 또는 ```CHOICES 선택지 블록이 아예 도달하지 못했거나 250자 미만인 경우
        const hasChoices = accumulatedText.toLowerCase().includes("choices") || /^(?:[-•·*]\s*)?(?:\d+[.)]|\([0-9]\)|[①-⑩])\s+/m.test(accumulatedText);
        const isPrematureEnd = (!lastFinishReason || lastFinishReason !== "STOP") && (!hasChoices || accumulatedText.trim().length < 250);

        if (isPrematureEnd && attempt < maxRetries - 1) {
          console.warn(`스트림 미완성 종료 감지 (finishReason: ${lastFinishReason}, len: ${accumulatedText.length}) -> 자동 재시도`);
          continue;
        }

        // 성공적으로 스트리밍 완료
        break;
      } catch (err) {
        lastErr = err.message;
        if (attempt === maxRetries - 1) throw err;
      }
    }

    // 본문 수신 검증: 3회 재시도 후에도 수신된 본문이 전무하다면 유령 말풍선 대신 명확한 에러 안내
    if (!accumulatedText || accumulatedText.trim().length === 0) {
      throw new Error(lastErr || "구글 서버로부터 응답을 수신하지 못했습니다. (API 키 권한 또는 네트워크 상태를 확인해주세요)");
    }

    // 스트리밍 완료 후: 상태창 및 선택지 정밀 상호 독립 파싱
    let { finalText, status, choices } = parseTurnOutput(accumulatedText);

    // 필터 중단 감지 시 친절한 안내 및 이어가기 유도
    if (lastFinishReason === "RECITATION") {
      finalText += "\n\n*(💡 원작 본문 복제 감지로 출력이 일시 중단되었습니다. 하단의 '▶️ 계속' 버튼을 누르시면 이어서 진행됩니다.)*";
    } else if (lastFinishReason === "SAFETY") {
      finalText += "\n\n*(💡 안전 필터 감지로 출력이 일시 중단되었습니다. 하단의 '▶️ 계속' 버튼을 누르시면 이어서 진행됩니다.)*";
    }

    // 본문 최종 렌더링
    contentEl.innerHTML = renderMarkdown(finalText);

    // 상태창 폴백: 만약 AI가 이번 턴에 상태창을 생략했더라도, 이전 턴에 확립된 상태창이 있다면 계승
    let effectiveStatus = status;
    if (!effectiveStatus) {
      for (let i = renderedMessages.length - 1; i >= 0; i--) {
        if (renderedMessages[i].role === "assistant" && renderedMessages[i].status) {
          effectiveStatus = { ...renderedMessages[i].status };
          break;
        }
      }
    }

    // 상태창 카드 렌더링
    if (effectiveStatus) {
      const cardEl = renderStatusCard(effectiveStatus);
      bubble.appendChild(cardEl);
    }

    // 선택지 폴백: AI가 선택지 출력을 누락했더라도, 현재 작품/상황/인물에 100% 밀착된 동적 맞춤 대안 3개 자동 보충
    let effectiveChoices = choices;
    if (!effectiveChoices || effectiveChoices.length === 0) {
      effectiveChoices = generateContextAwareFallbackChoices(finalText, effectiveStatus, text);
    }

    // 선택지 버튼 렌더링
    if (effectiveChoices && effectiveChoices.length > 0) {
      const choicesEl = renderChoices(effectiveChoices);
      bubble.appendChild(choicesEl);
    }

    // AI 응답 히스토리에 누적 (다음 턴에서 AI가 상태창과 선택지 형식을 잊지 않도록 코드블록 보정 누적)
    let historyText = accumulatedText;
    if (!status && effectiveStatus) {
      historyText += `\n\n\`\`\`INFO\n빙의: ${effectiveStatus.possession || ""}\n장비: ${effectiveStatus.equipment || ""}\n능력: ${effectiveStatus.ability || ""}\n시간: ${effectiveStatus.time || ""}\n장소: ${effectiveStatus.location || ""}\n\`\`\``;
    }
    if ((!choices || choices.length === 0) && effectiveChoices) {
      historyText += `\n\n\`\`\`CHOICES\n1. ${effectiveChoices[0]}\n2. ${effectiveChoices[1]}\n3. ${effectiveChoices[2]}\n\`\`\``;
    }

    conversationHistory.push({
      role: "model",
      parts: [{ text: historyText }],
    });

    renderedMessages.push({
      role: "assistant",
      text: finalText,
      status: effectiveStatus,
      choices: effectiveChoices,
    });

    // 상태창 빙의 캐릭터가 감지되면 세션 제목을 더 멋지게 갱신 (예: "거미입니다만 [시라오리]")
    if (cur && status && status.빙의) {
      const firstUserMsg = conversationHistory.find((h) => h.role === "user")?.parts?.[0]?.text;
      const baseTitle = formatSessionTitle(firstUserMsg || cur.title);
      cur.title = `${baseTitle} [${status.빙의}]`;
    }

    saveChatToStorage();
    checkSaveReminder();

    scrollToBottom();
  } catch (err) {
    contentEl.innerHTML = `<div style="color: #ef4444;">⚠️ 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
  } finally {
    isGenerating = false;
    btnSendEl.disabled = false;
    chatInputEl.focus();
  }
}

// 시작
window.addEventListener("DOMContentLoaded", initApp);

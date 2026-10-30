/**
 * 창작물 빙의 시뮬레이션 (창·빙·시) 웹 클라이언트 엔진
 * 원본 바이트코드(index.android.bundle) 파싱 로직 및 Google Gemini 공식 스트리밍 API 탑재
 */

// =============================================================================
// 1. 역공학으로 복원한 파서 상수 및 함수들 (어떤 형식으로 출력되어도 100% 감지)
// =============================================================================
const INFO_BLOCK_REGEX = /```(?:INFO|info|status|STATUS)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const CHOICES_BLOCK_REGEX = /```(?:CHOICES|choices)\s*[\r\n]+([\s\S]*?)(?:```|$)/i;
const DIALOGUE_QUOTE_REGEX = /^["“「『]/;

const STATUS_WINDOW_FIELDS = [
  { key: "possession", icon: "👤", label: "빙의" },
  { key: "equipment", icon: "🎒", label: "장비" },
  { key: "ability", icon: "🌟", label: "능력" },
  { key: "time", icon: "🕗", label: "시간" },
  { key: "location", icon: "🌍", label: "장소" },
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
 * 줄글에서 필드값 추출 (콜론, 별표, 불릿, 띄어쓰기 완벽 대응)
 */
function parseFields(blockContent) {
  const result = {};
  const lines = blockContent.split("\n");
  for (const line of lines) {
    for (const field of STATUS_WINDOW_FIELDS) {
      // "빙의:", "**빙의:**", "- 빙의 :", "• 빙의:" 등 모든 변형 매칭
      const regex = new RegExp(`(?:^|[\\s*•\\-])${field.label}[*]*\\s*[:：]\\s*(.+)`, "i");
      const match = line.match(regex);
      if (match && match[1]) {
        let val = match[1].trim();
        // 대괄호 [ ... ] 나 끝의 별표 ** 정리
        val = val.replace(/^\[(.*)\]$/, "$1").replace(/\*\*$/, "").trim();
        if (val) result[field.key] = val;
      }
    }
  }
  return result;
}

/**
 * 상태창 데이터 추출 (코드블록 형태 및 일반 텍스트 목록 형태 모두 지원)
 */
function extractStatusWindow(text) {
  // 1) ```INFO ... ``` 코드블록이 있는 경우
  const blockMatch = text.match(INFO_BLOCK_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const cleanedText = (text.slice(0, blockMatch.index) + text.slice(blockMatch.index + blockMatch[0].length)).trim();
    const fields = parseFields(blockMatch[1]);
    const hasAny = Object.values(fields).some(Boolean);
    if (hasAny) {
      return { text: cleanedText, status: fields };
    }
  }

  // 2) 코드블록 태그 없이 본문 안에 "빙의:", "장비:", "능력:" 등으로 나열된 경우 자동 감지
  const looseFields = parseFields(text);
  const matchedFieldCount = Object.keys(looseFields).length;
  if (matchedFieldCount >= 2) {
    // 본문에서 상태창에 해당하는 줄들만 깔끔하게 제거
    const lines = text.split("\n");
    const preservedLines = [];
    for (const line of lines) {
      let isStatusLine = false;
      for (const field of STATUS_WINDOW_FIELDS) {
        const regex = new RegExp(`(?:^|[\\s*•\\-])${field.label}[*]*\\s*[:：]`, "i");
        if (regex.test(line)) {
          isStatusLine = true;
          break;
        }
      }
      if (!isStatusLine && !line.includes("상태창") && !line.includes("STATUS")) {
        preservedLines.push(line);
      }
    }
    return { text: preservedLines.join("\n").trim(), status: looseFields };
  }

  return { text, status: null };
}

/**
 * 선택지 불릿/번호 정제
 */
function cleanLine(line) {
  return line
    .trim()
    .replace(/^(?:\d+[.)]|[-•·*]|\([0-9]\)|[①-⑩])\s*/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .trim();
}

/**
 * 선택지 3~5개 추출 (코드블록 형태 및 하단 1, 2, 3 번호 나열 형태 모두 지원)
 */
function extractChoices(text) {
  // 1) ```CHOICES ... ``` 코드블록이 있는 경우
  const blockMatch = text.match(CHOICES_BLOCK_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const cleanedText = (text.slice(0, blockMatch.index) + text.slice(blockMatch.index + blockMatch[0].length)).trim();
    const rawLines = blockMatch[1].split("\n");
    const choices = rawLines
      .map(cleanLine)
      .filter((l) => l.length > 0)
      .slice(0, 5);
    if (choices.length > 0) {
      return { text: cleanedText, choices };
    }
  }

  // 2) 코드블록 없이 본문 끝에 "1. ...", "2. ...", "3. ..." 형태로 적힌 경우 자동 감지
  const lines = text.split("\n");
  const extractedChoices = [];
  const textLines = [];
  let choiceSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isNumbered = /^(?:\d+[.)]|\([0-9]\)|[①-⑩])\s+/.test(line);

    if (isNumbered) {
      choiceSectionStarted = true;
      const cleaned = cleanLine(line);
      if (cleaned) extractedChoices.push(cleaned);
    } else if (choiceSectionStarted && line === "") {
      // 선택지 사이 공백 건너뜀
      continue;
    } else {
      if (choiceSectionStarted && extractedChoices.length >= 2) {
        // 선택지 영역이 끝난 후 나머지 텍스트
        textLines.push(line);
      } else {
        textLines.push(lines[i]);
      }
    }
  }

  if (extractedChoices.length >= 2) {
    return { text: textLines.join("\n").trim(), choices: extractedChoices.slice(0, 5) };
  }

  return { text, choices: [] };
}

/**
 * 스트리밍 도중 열린 미완성 코드블록을 화면에서 숨김 (Func 19561)
 */
function stripTrailingBlocksForStreaming(text) {
  const tags = ["```CHOICES", "```choices", "```INFO", "```info", "```STATUS", "```status"];
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

[스토리 진행 필수 양식]
플레이어가 작품명을 말하거나 행동을 입력하면, 스토리를 생생하게 진행하며 매 턴 반드시 아래 3단계를 순서대로 출력하세요:

1. 스토리 본문:
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

3. 선택지 (반드시 아래 CHOICES 블록으로 3개 제시):
\`\`\`CHOICES
1. [행동 선택지 1]
2. [행동 선택지 2]
3. [행동 선택지 3]
\`\`\`

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
  - 맥락을 갑작스럽게 건너뛰거나(Fade to black), 성의 없이 단 몇 줄로 얼버무리며 다음 날로 넘어가지 마십시오.
  - 직접적·해부학적인 단어 나열 대신, 인물들의 가빠지는 호흡, 흔들리는 눈빛, 붉어지는 뺨과 피부의 열기, 심장 박동의 울림, 미세한 손끝의 떨림과 귓가에 닿는 숨소리 등 '오감과 내면 심리'를 문학적이고 감각적인 은유로 깊이 있게 서술하십시오.
  - 인물의 대사에는 억눌렸던 갈망, 망설임, 애절함 등의 감정선을 가득 담아 긴장감과 몰입감이 절정까지 매끄럽게 이어지도록 서사적 여운을 극대화하십시오.`;

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
if (!savedModel || savedModel.includes("3.6") || savedModel.includes("3.5-flash") || savedModel === "gemini-3.8-flash") {
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

  try {
    let response = null;
    let lastErr = null;
    const maxRetries = 3;

    // 일시적인 503/429 트래픽 스파이크를 자동으로 극복하는 지능형 재시도 루프
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        contentEl.innerHTML = `<div style="font-size: 12px; color: var(--current-accent);">🔄 구글 서버 트래픽 혼잡 감지 -> 1.5초 후 자동 재시도 중 (${attempt}/${maxRetries - 1})...</div>`;
        await new Promise((r) => setTimeout(r, 1500));
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const genConfig = {
        temperature: 0.85,
        maxOutputTokens: 3000,
      };
      if (!selectedModel.includes("lite")) {
        genConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const payload = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: conversationHistory,
        generationConfig: genConfig,
      };

      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          break; // 통신 성공 -> 스트리밍 개시
        }

        const errJson = await response.json().catch(() => null);
        lastErr = (errJson && errJson.error && errJson.error.message) || `HTTP ${response.status} 오류`;

        // 503(High Demand) 또는 429(Rate Limit) 일시적 에러는 재시도
        if (response.status === 503 || response.status === 429 || lastErr.includes("high demand") || lastErr.includes("overloaded")) {
          continue;
        } else {
          throw new Error(lastErr);
        }
      } catch (err) {
        lastErr = err.message;
        if (attempt === maxRetries - 1) throw err;
      }
    }

    if (!response || !response.ok) {
      throw new Error(lastErr || "구글 서버 응답 오류");
    }

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

            // 1) Interactions API 이벤트 처리
            if (data.interaction && data.interaction.id) {
              lastInteractionId = data.interaction.id;
            }
            let chunk = "";
            if (data.event_type === "step.delta" && data.delta && data.delta.type === "text") {
              chunk = data.delta.text;
            } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
              // 2) 클래식 API 처리
              chunk = data.candidates[0].content.parts[0].text;
            }

            if (chunk) {
              accumulatedText += chunk;

              // 스트리밍 도중에는 ```INFO, ```CHOICES 코드블록이 열린 채 노출되지 않도록 마스킹
              const visibleStreamText = stripTrailingBlocksForStreaming(accumulatedText);
              contentEl.innerHTML = renderMarkdown(visibleStreamText);
              scrollToBottom();
            }
          } catch (e) {
            // JSON 파싱 경계 무시
          }
        }
      }
    }

    // 스트리밍 완료 후: 상태창 및 선택지 정밀 파싱
    const { text: textWithoutStatus, status } = extractStatusWindow(accumulatedText);
    const { text: finalText, choices } = extractChoices(textWithoutStatus);

    // 본문 최종 렌더링
    contentEl.innerHTML = renderMarkdown(finalText);

    // 상태창 카드 렌더링
    if (status) {
      const cardEl = renderStatusCard(status);
      bubble.appendChild(cardEl);
    }

    // 선택지 버튼 렌더링
    if (choices && choices.length > 0) {
      const choicesEl = renderChoices(choices);
      bubble.appendChild(choicesEl);
    }

    // AI 응답 히스토리에 누적
    conversationHistory.push({
      role: "model",
      parts: [{ text: accumulatedText }],
    });

    renderedMessages.push({
      role: "assistant",
      text: finalText,
      status: status,
      choices: choices,
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

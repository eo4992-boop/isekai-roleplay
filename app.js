/**
 * 창작물 빙의 시뮬레이션 (창·빙·시) 웹 클라이언트 엔진
 * 원본 바이트코드(index.android.bundle) 파싱 로직 및 Google Gemini 공식 스트리밍 API 탑재
 */

// =============================================================================
// 1. 역공학으로 복원한 파서 상수 및 함수들 (@isekai/shared & UI Renderer)
// =============================================================================
const INFO_REGEX = /```INFO\s*\n([\s\S]*?)```/;
const CHOICES_REGEX = /```CHOICES\s*\n([\s\S]*?)```/;
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
 * INFO 코드블록 내부 줄글 파싱 (Func 16514)
 */
function parseFields(blockContent) {
  const result = {};
  const lines = blockContent.split("\n");
  for (const line of lines) {
    for (const field of STATUS_WINDOW_FIELDS) {
      const prefix = field.label + ":";
      const idx = line.indexOf(prefix);
      if (idx !== -1) {
        const val = line.slice(idx + prefix.length).trim();
        if (val) result[field.key] = val;
      }
    }
  }
  return result;
}

/**
 * 상태창 데이터 추출 (Func 16515)
 */
function extractStatusWindow(text) {
  const match = text.match(INFO_REGEX);
  if (!match || match.index === undefined) {
    return { text, status: null };
  }
  const cleanedText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  const fields = parseFields(match[1]);
  const hasAny = Object.values(fields).some(Boolean);
  return { text: cleanedText, status: hasAny ? fields : null };
}

/**
 * 선택지 불릿/번호 정제 (Func 19558)
 */
function cleanLine(line) {
  return line.trim().replace(/^(?:\d+[.)]|[-•·])\s+/, "").trim();
}

/**
 * 선택지 3~5개 추출 (Func 19559)
 */
function extractChoices(text) {
  const match = text.match(CHOICES_REGEX);
  if (!match || match.index === undefined) {
    return { text, choices: [] };
  }
  const cleanedText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  const rawLines = match[1].split("\n");
  const choices = rawLines
    .map(cleanLine)
    .filter((l) => l.length > 0)
    .slice(0, 5);
  return { text: cleanedText, choices };
}

/**
 * 스트리밍 도중 열린 미완성 코드블록을 화면에서 숨김 (Func 19561)
 */
function stripTrailingBlocksForStreaming(text) {
  const tags = ["```CHOICES", "```INFO"];
  const indices = tags.map((tag) => text.indexOf(tag)).filter((idx) => idx !== -1);
  if (indices.length === 0) return text;
  const cutPoint = Math.min(...indices);
  return text.slice(0, cutPoint).trimEnd();
}

// =============================================================================
// 2. 앱 상태 및 시스템 프롬프트 (Gemini Engine용)
// =============================================================================
const SYSTEM_PROMPT = `당신은 '창작물 빙의 시뮬레이션(창·빙·시)'의 전속 AI 안내 도우미 '레이카'이자 게임 마스터(GM)입니다.
플레이어가 원하는 창작물(애니, 게임, 웹툰, 라노벨 등) 세계관에 플레이어를 빙의시켜 롤플레잉을 진행합니다.

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
- 관찰모드: 플레이어의 행동까지 AI가 소설처럼 자율 서술`;

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
let selectedModel = localStorage.getItem("GEMINI_MODEL") || "gemini-3.8-flash";
let currentTheme = localStorage.getItem("STATUS_THEME") || "gold";
let conversationHistory = []; // { role: "user" | "model", parts: [{ text }] }
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
const inputApiKeyEl = document.getElementById("input-api-key");
const selectModelEl = document.getElementById("select-model");
const selectThemeEl = document.getElementById("select-theme");
const modelBadgeEl = document.getElementById("model-badge");

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

  // 첫 환영 온보딩 메시지 출력 (클라이언트 로컬 즉시 생성)
  resetConversation();

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
  btnNewChatEl.addEventListener("click", () => {
    if (confirm("새로운 시뮬레이션을 시작하시겠습니까? 현재 대화가 초기화됩니다.")) {
      resetConversation();
    }
  });

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
  settingsModalEl.style.display = "flex";
}

function closeSettingsModal() {
  settingsModalEl.style.display = "none";
}

function saveSettings() {
  apiKey = inputApiKeyEl.value.trim();
  selectedModel = selectModelEl.value;
  applyTheme(selectThemeEl.value);

  localStorage.setItem("GEMINI_API_KEY", apiKey);
  localStorage.setItem("GEMINI_MODEL", selectedModel);

  modelBadgeEl.textContent = selectedModel.replace("gemini-", "");
  closeSettingsModal();
}

function resetConversation() {
  chatMessagesEl.innerHTML = "";
  conversationHistory = [];
  lastInteractionId = null;
  appendAssistantMessage(ONBOARDING_MESSAGE, null, [
    "나루토 세계관으로 빙의",
    "원피스 세계관으로 빙의",
    "주술회전 세계관으로 빙의",
  ]);
}

// =============================================================================
// 5. 메시지 렌더링 함수들 (대사/나레이션 분기, 상태창 카드, 선택지 버튼)
// =============================================================================
function appendUserMessage(text) {
  const row = document.createElement("div");
  row.className = "message-row user";
  row.innerHTML = `<div class="bubble-user">${escapeHtml(text)}</div>`;
  chatMessagesEl.appendChild(row);
  scrollToBottom();
}

function appendAssistantMessage(fullText, statusData = null, choices = []) {
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
    let response;
    const isInteractionsApi = selectedModel.includes("3.8");

    if (isInteractionsApi) {
      // 최신 공식 Interactions API 호출 (Google 권장 차세대 API)
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse`;
      const payload = {
        model: selectedModel,
        input: text,
        stream: true,
      };

      if (lastInteractionId) {
        payload.previous_interaction_id = lastInteractionId;
      } else {
        payload.system_instruction = SYSTEM_PROMPT;
      }

      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });
    } else {
      // 클래식 generateContent API 호출
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const payload = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: conversationHistory,
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: 3000,
        },
      };

      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      throw new Error((errJson && errJson.error && errJson.error.message) || `HTTP ${response.status} 오류`);
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

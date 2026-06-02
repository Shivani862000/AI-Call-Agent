(function () {
  if (!window.AppShell || window.TestCallWidget) {
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const STATUS_LABELS = {
    ready: 'Ready',
    permission: 'Mic Permission Needed',
    connecting: 'Connecting',
    speaking: 'AI Speaking',
    listening: 'Listening',
    thinking: 'Thinking',
    completed: 'Completed',
    failed: 'Failed'
  };

  const TestAICallService = {
    start() {
      return window.AppShell.fetchJson(`${window.AppShell.API_BASE}/test-ai-call/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    },
    message(sessionId, message) {
      return window.AppShell.fetchJson(`${window.AppShell.API_BASE}/test-ai-call/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message })
      });
    },
    end(sessionId) {
      return window.AppShell.fetchJson(`${window.AppShell.API_BASE}/test-ai-call/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    }
  };

  function escapeHtml(value) {
    return window.AppShell.escapeHtml(value);
  }

  function createElementFromHtml(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    return wrapper.firstElementChild;
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remaining = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }

  class TestAICallWidget {
    constructor() {
      this.root = null;
      this.recognition = null;
      this.mediaStream = null;
      this.sessionId = '';
      this.callId = '';
      this.status = 'ready';
      this.isOpen = false;
      this.isMuted = false;
      this.isTranscriptOpen = false;
      this.isBusy = false;
      this.error = '';
      this.transcript = [];
      this.summary = null;
      this.startedAt = null;
      this.durationSeconds = 0;
      this.timerId = null;
      this.shouldListen = false;
    }

    mount() {
      if (document.querySelector('[data-test-ai-call-widget]')) {
        return;
      }

      this.root = createElementFromHtml(`
        <section class="test-call-widget test-ai-call-widget" data-test-ai-call-widget>
          <button class="test-call-fab test-ai-call-fab" type="button" aria-expanded="false" aria-controls="testAiCallPanel">
            <span class="test-call-fab-icon" aria-hidden="true"></span>
            <span class="test-call-fab-label">Test AI Call</span>
          </button>

          <div class="test-call-backdrop" hidden></div>
          <aside class="test-call-panel test-ai-call-panel" id="testAiCallPanel" aria-label="Browser AI voice call test" aria-hidden="true">
            <div class="test-call-panel-header">
              <div>
                <span class="test-call-kicker">Browser Voice Test</span>
                <h2>Test AI Call</h2>
              </div>
              <div class="test-call-header-actions">
                <button class="test-call-icon-button" type="button" data-action="minimize" aria-label="Minimize test AI call">
                  <span aria-hidden="true">-</span>
                </button>
                <button class="test-call-icon-button" type="button" data-action="close" aria-label="Close test AI call">
                  <span aria-hidden="true">x</span>
                </button>
              </div>
            </div>

            <div class="test-call-status-row">
              <span class="test-call-status-dot"></span>
              <strong data-role="statusText">Ready</strong>
              <span data-role="callTimer">00:00</span>
            </div>

            <div class="test-ai-call-stage">
              <div class="test-ai-avatar" aria-hidden="true">
                <span class="test-ai-phone-icon"></span>
              </div>
              <div class="voice-wave-animation" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span>
              </div>
              <h3 data-role="stageTitle">Ready for a browser AI call</h3>
              <p data-role="stageText">Click Start Call and allow microphone access. The AI will speak first.</p>
            </div>

            <div class="test-ai-permission" data-role="permissionScreen">
              <button class="test-call-primary test-ai-start" type="button" data-action="start">
                Start Call
              </button>
              <div class="test-call-error" data-role="error" hidden></div>
            </div>

            <div class="test-ai-live" data-role="liveScreen" hidden>
              <div class="test-ai-last-turn" data-role="lastTurn">Waiting for audio...</div>
              <div class="test-ai-controls">
                <button class="test-ai-control" type="button" data-action="mute">
                  <span data-role="muteText">Mute</span>
                </button>
                <button class="test-ai-end" type="button" data-action="end">End Call</button>
                <button class="test-ai-control" type="button" data-action="transcript">
                  Show Transcript
                </button>
              </div>
            </div>

            <div class="call-summary-card" data-role="summaryCard" hidden></div>

            <div class="transcript-drawer" data-role="transcriptDrawer" hidden>
              <div class="transcript-drawer-header">
                <strong>Transcript</strong>
                <button type="button" data-action="transcript">Hide</button>
              </div>
              <div class="test-call-transcript" data-role="transcript" aria-live="polite"></div>
            </div>
          </aside>
        </section>
      `);

      document.body.appendChild(this.root);
      this.bindEvents();
      this.render();
    }

    bindEvents() {
      this.root.querySelector('.test-call-fab').addEventListener('click', () => this.open());
      this.root.querySelector('.test-call-backdrop').addEventListener('click', () => this.requestClose());
      this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.requestClose());
      this.root.querySelector('[data-action="minimize"]').addEventListener('click', () => this.minimize());
      this.root.querySelector('[data-action="start"]').addEventListener('click', () => this.startCall());
      this.root.querySelector('[data-action="mute"]').addEventListener('click', () => this.toggleMute());
      this.root.querySelector('[data-action="end"]').addEventListener('click', () => this.requestEndCall());
      this.root.querySelectorAll('[data-action="transcript"]').forEach((button) => {
        button.addEventListener('click', () => this.toggleTranscript());
      });
    }

    open() {
      this.isOpen = true;
      if (this.status === 'ready') {
        this.status = 'permission';
      }
      this.render();
    }

    minimize() {
      this.isOpen = false;
      this.render();
    }

    async requestClose() {
      if (['speaking', 'listening', 'thinking', 'connecting'].includes(this.status)) {
        const shouldEnd = window.confirm('End this live browser AI call before closing?');
        if (!shouldEnd) {
          return;
        }
        await this.endCall();
        return;
      }
      this.isOpen = false;
      this.render();
    }

    async requestEndCall() {
      const shouldEnd = window.confirm('End this test AI call now? The transcript and summary will be saved.');
      if (!shouldEnd) {
        return;
      }
      await this.endCall();
    }

    setStatus(status) {
      this.status = status;
      this.render();
    }

    setBusy(isBusy) {
      this.isBusy = isBusy;
      this.render();
    }

    startTimer() {
      this.stopTimer();
      this.startedAt = Date.now();
      this.durationSeconds = 0;
      this.timerId = window.setInterval(() => {
        this.durationSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
        this.renderTimer();
      }, 1000);
    }

    stopTimer() {
      if (this.timerId) {
        window.clearInterval(this.timerId);
        this.timerId = null;
      }
    }

    async requestMicPermission() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone permission is not supported in this browser.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = stream;
      return stream;
    }

    createRecognition() {
      if (!SpeechRecognition) {
        throw new Error('SpeechRecognition is not available in this browser. Chrome or Edge works best for this POC.');
      }

      const recognition = new SpeechRecognition();
      recognition.lang = 'hi-IN';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        const result = event.results?.[0]?.[0]?.transcript || '';
        const text = String(result).trim();
        if (text) {
          this.handleUserSpeech(text);
        } else if (this.shouldListen && !this.isMuted) {
          this.listen();
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.error = 'Microphone permission was blocked. Allow mic access and try again.';
          this.setStatus('failed');
          return;
        }

        if (this.shouldListen && !this.isMuted && this.status === 'listening') {
          window.setTimeout(() => this.listen(), 600);
        }
      };

      recognition.onend = () => {
        if (this.shouldListen && !this.isMuted && this.status === 'listening') {
          window.setTimeout(() => this.listen(), 350);
        }
      };

      this.recognition = recognition;
    }

    async startCall() {
      this.error = '';
      this.summary = null;
      this.transcript = [];
      this.isTranscriptOpen = false;
      this.setBusy(true);
      this.setStatus('connecting');

      try {
        await this.requestMicPermission();
        this.createRecognition();
        const result = await TestAICallService.start();
        this.sessionId = result.sessionId;
        this.callId = result.callId;
        this.transcript = result.transcript || [];
        this.shouldListen = true;
        this.startTimer();
        await this.speak(result.aiResponse || this.latestAgentText());
      } catch (error) {
        this.error = error.message || 'Unable to start browser AI call';
        this.setStatus('failed');
      } finally {
        this.setBusy(false);
      }
    }

    latestAgentText() {
      const latest = [...this.transcript].reverse().find((turn) => turn.role === 'AGENT');
      return latest?.text || '';
    }

    latestTurnText() {
      const latest = this.transcript[this.transcript.length - 1];
      if (!latest) {
        return 'Waiting for audio...';
      }
      return `${latest.role === 'AGENT' ? 'AI' : 'You'}: ${latest.text}`;
    }

    speak(text) {
      return new Promise((resolve) => {
        const speechText = String(text || '').trim();
        if (!speechText || !window.speechSynthesis) {
          this.listen();
          resolve();
          return;
        }

        this.stopListening();
        this.setStatus('speaking');
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(speechText);
        utterance.lang = 'hi-IN';
        utterance.rate = 0.92;
        utterance.pitch = 1;
        utterance.onend = () => {
          if (this.status !== 'completed' && this.status !== 'failed') {
            this.listen();
          }
          resolve();
        };
        utterance.onerror = () => {
          if (this.status !== 'completed' && this.status !== 'failed') {
            this.listen();
          }
          resolve();
        };
        window.speechSynthesis.speak(utterance);
      });
    }

    listen() {
      if (!this.recognition || this.isMuted || !this.shouldListen || this.status === 'completed') {
        return;
      }

      try {
        this.setStatus('listening');
        this.recognition.start();
      } catch (error) {
        // Recognition may already be active; ignore and let the active listener finish.
      }
    }

    stopListening() {
      if (!this.recognition) {
        return;
      }
      try {
        this.recognition.stop();
      } catch (error) {
        // Stop can throw when recognition is idle.
      }
    }

    async handleUserSpeech(text) {
      if (!this.sessionId || this.status === 'completed') {
        return;
      }

      this.shouldListen = false;
      this.setBusy(true);
      this.setStatus('thinking');

      try {
        const result = await TestAICallService.message(this.sessionId, text);
        this.transcript = result.transcript || this.transcript;
        this.shouldListen = true;
        await this.speak(result.aiResponse);
      } catch (error) {
        this.error = error.message || 'Unable to get AI response';
        this.setStatus('failed');
      } finally {
        this.setBusy(false);
      }
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      if (this.isMuted) {
        this.stopListening();
      } else if (this.status !== 'speaking' && this.status !== 'thinking' && this.status !== 'completed') {
        this.shouldListen = true;
        this.listen();
      }
      this.render();
    }

    toggleTranscript() {
      this.isTranscriptOpen = !this.isTranscriptOpen;
      this.render();
    }

    async endCall() {
      this.shouldListen = false;
      this.stopListening();
      window.speechSynthesis?.cancel();
      this.mediaStream?.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
      this.stopTimer();

      if (!this.sessionId) {
        this.setStatus('completed');
        return;
      }

      this.setBusy(true);
      try {
        const result = await TestAICallService.end(this.sessionId);
        this.transcript = result.transcript || this.transcript;
        this.summary = result.summary || null;
        this.setStatus('completed');
        if (result.saved) {
          window.AppShell.showAlert('Browser test call saved');
        }
      } catch (error) {
        this.error = error.message || 'Unable to end browser AI call';
        this.setStatus('failed');
      } finally {
        this.setBusy(false);
      }
    }

    renderTimer() {
      const timer = this.root?.querySelector('[data-role="callTimer"]');
      if (timer) {
        timer.textContent = formatDuration(this.durationSeconds);
      }
    }

    renderTranscript() {
      const transcriptEl = this.root.querySelector('[data-role="transcript"]');
      transcriptEl.innerHTML = this.transcript.map((turn) => {
        const isAgent = turn.role === 'AGENT';
        return `
          <div class="test-call-turn ${isAgent ? 'agent' : 'patient'}">
            <span>${isAgent ? 'AI' : 'You'}</span>
            <p>${escapeHtml(turn.text)}</p>
          </div>
        `;
      }).join('');
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    renderSummary() {
      const summaryCard = this.root.querySelector('[data-role="summaryCard"]');
      summaryCard.hidden = this.status !== 'completed' || !this.summary;
      if (!this.summary) {
        summaryCard.innerHTML = '';
        return;
      }

      summaryCard.innerHTML = `
        <strong>Feedback Summary</strong>
        <p>${escapeHtml(this.summary.reviewText)}</p>
        <div class="call-summary-meta">
          <span>Rating: ${this.summary.stars || '--'}/5</span>
          <span>Sentiment: ${escapeHtml(this.summary.sentiment || 'neutral')}</span>
        </div>
      `;
    }

    render() {
      if (!this.root) {
        return;
      }

      const activeCall = ['connecting', 'speaking', 'listening', 'thinking'].includes(this.status);
      const panel = this.root.querySelector('.test-call-panel');
      const fab = this.root.querySelector('.test-call-fab');
      const backdrop = this.root.querySelector('.test-call-backdrop');
      const statusText = this.root.querySelector('[data-role="statusText"]');
      const stageTitle = this.root.querySelector('[data-role="stageTitle"]');
      const stageText = this.root.querySelector('[data-role="stageText"]');
      const permissionScreen = this.root.querySelector('[data-role="permissionScreen"]');
      const liveScreen = this.root.querySelector('[data-role="liveScreen"]');
      const errorEl = this.root.querySelector('[data-role="error"]');
      const lastTurn = this.root.querySelector('[data-role="lastTurn"]');
      const muteText = this.root.querySelector('[data-role="muteText"]');
      const transcriptDrawer = this.root.querySelector('[data-role="transcriptDrawer"]');

      this.root.dataset.status = this.status;
      this.root.classList.toggle('open', this.isOpen);
      this.root.classList.toggle('busy', this.isBusy);
      this.root.classList.toggle('muted', this.isMuted);
      fab.setAttribute('aria-expanded', String(this.isOpen));
      panel.setAttribute('aria-hidden', String(!this.isOpen));
      backdrop.hidden = !this.isOpen;
      statusText.textContent = STATUS_LABELS[this.status] || STATUS_LABELS.ready;
      permissionScreen.hidden = activeCall || this.status === 'completed';
      liveScreen.hidden = !activeCall && this.status !== 'completed';
      errorEl.hidden = !this.error;
      errorEl.textContent = this.error;
      lastTurn.textContent = this.latestTurnText();
      muteText.textContent = this.isMuted ? 'Unmute' : 'Mute';
      transcriptDrawer.hidden = !this.isTranscriptOpen;

      const copy = {
        ready: ['Ready for a browser AI call', 'Click Start Call and allow microphone access. The AI will speak first.'],
        permission: ['Microphone permission needed', 'Start the call to grant mic access. No name, phone, or form is required.'],
        connecting: ['Connecting browser call', 'Preparing microphone, AI prompt, and voice playback.'],
        speaking: ['AI is speaking', 'Listen to the AI receptionist. The mic will reopen after the response.'],
        listening: ['Listening', this.isMuted ? 'Muted. Unmute to continue.' : 'Speak naturally. Your voice will be converted to text.'],
        thinking: ['AI is thinking', 'Your speech is being sent to the AI receptionist.'],
        completed: ['Call completed', 'Transcript and feedback summary are ready.'],
        failed: ['Call failed', this.error || 'Check microphone permission and browser support.']
      }[this.status] || ['Ready for a browser AI call', 'Click Start Call to begin.'];

      stageTitle.textContent = copy[0];
      stageText.textContent = copy[1];

      this.root.querySelectorAll('button').forEach((button) => {
        if (['close', 'minimize', 'transcript'].includes(button.dataset.action)) {
          return;
        }
        button.disabled = this.isBusy || (this.status === 'completed' && button.dataset.action !== 'start');
      });

      this.renderTimer();
      this.renderTranscript();
      this.renderSummary();
    }
  }

  window.TestAICallWidget = TestAICallWidget;
  window.TestCallWidget = TestAICallWidget;
  window.TestAICallService = TestAICallService;
})();

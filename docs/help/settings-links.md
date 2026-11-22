---
id: settings-links
title: Links to settings and individual controls
keywords: [settings, links, navigation, token, authentication, configuration, deep links]
related: [settings-and-appearance, git, talking-to-an-agent]
---

Agents can use these destinations in Markdown answers. Clicking a link opens the desktop settings page, expands containing sections and highlights the control where available. Links never fill or change values. On the phone these destinations explain that desktop navigation is required.

Search settings also offers Copy link beside each result. Prefer those links or the catalog below over guessing a destination. A removed control falls back to its containing page.

<!-- Generated from settingsLinkTargets. Update with UPDATE_SETTINGS_LINKS=1 and the SettingsLinkCatalog test. -->

| Page | Setting | Link |
|---|---|---|
| general | General | tabtivity://settings/general |
| general | Theme | tabtivity://settings/general/settings.theme |
| general | Theme colors | tabtivity://settings/general/settings.themeVars |
| general | Language | tabtivity://settings/general/settings.language |
| general | Show untested tags | tabtivity://settings/general/settings.showUntestedTags |
| general | Hide other windows while presenting | tabtivity://settings/general/settings.privacyCurtain |
| general | Run scripts in background | tabtivity://settings/general/settings.runScriptsBg |
| general | Persistent local sessions | tabtivity://settings/general/settings.persistLocal |
| layout | Layout | tabtivity://settings/layout |
| layout | Window zoom | tabtivity://settings/layout/settings.windowZoom |
| layout | Auto-hide the side panel | tabtivity://settings/layout/settings.sidePanelAutoHide |
| layout | Close a subwindow with its last tab | tabtivity://settings/layout/settings.closeSubwindowOnLastTab |
| layout | Min subwindow width (px) | tabtivity://settings/layout/settings.minSubWidth |
| layout | Min subwindow height (px) | tabtivity://settings/layout/settings.minSubHeight |
| clock | Clock | tabtivity://settings/clock |
| clock | Show seconds in header clock | tabtivity://settings/clock/settings.showClockSeconds |
| clock | 24-hour clock | tabtivity://settings/clock/settings.clock24 |
| hintsOnboarding | Hints & onboarding | tabtivity://settings/hintsOnboarding |
| hintsOnboarding | Show contextual hints | tabtivity://settings/hintsOnboarding/settings.showHints |
| hintsOnboarding | How to start... | tabtivity://settings/hintsOnboarding/settings.howToStart |
| hintsOnboarding | Lessons | tabtivity://settings/hintsOnboarding/settings.lessons |
| hintsOnboarding | Quick tour | tabtivity://settings/hintsOnboarding/lessons.tour.title |
| hintsOnboarding | Tour: other machines | tabtivity://settings/hintsOnboarding/lessons.tourRemote.title |
| hintsOnboarding | Reset hints | tabtivity://settings/hintsOnboarding/settings.resetHints |
| shortcuts | Keyboard Shortcuts | tabtivity://settings/shortcuts |
| updates | Updates | tabtivity://settings/updates |
| updates | Installed version | tabtivity://settings/updates/updates.installedVersion |
| help | Feature Guide | tabtivity://settings/help |
| global | Global Apps | tabtivity://settings/global |
| filetypes | File Type Apps | tabtivity://settings/filetypes |
| downloads | Downloads | tabtivity://settings/downloads |
| downloads | Add download folder... | tabtivity://settings/downloads/settings.addDownloadFolder |
| browser | Browser | tabtivity://settings/browser |
| browser | Home address | tabtivity://settings/browser/settings.browserHome |
| browser | Search address | tabtivity://settings/browser/settings.browserSearch |
| browser | Open links in | tabtivity://settings/browser/settings.browserLinkTarget |
| browser | Reload open pages at startup | tabtivity://settings/browser/settings.browserRestoreNavigate |
| browser | Allow live pages | tabtivity://settings/browser/settings.browserLivePages |
| mail | Mail | tabtivity://settings/mail |
| mail | Mail client | tabtivity://settings/mail/settings.mailClient |
| mail | Check for new mail | tabtivity://settings/mail/settings.mailCheckInterval |
| calendar | Calendar | tabtivity://settings/calendar |
| calendar | Calendar in the header | tabtivity://settings/calendar/settings.calendarGlobalApp |
| calendar | To-do board button in the header | tabtivity://settings/calendar/settings.todoBoard |
| calendar | Week starts on | tabtivity://settings/calendar/settings.weekStartsOn |
| calendar | Default view | tabtivity://settings/calendar/settings.defaultView |
| calendar | Day grid starts at | tabtivity://settings/calendar/settings.dayGridStart |
| calendar | Default reminder | tabtivity://settings/calendar/settings.defaultReminder |
| usageStats | Usage stats | tabtivity://settings/usageStats |
| usageStats | Show the recap at the start of each day | tabtivity://settings/usageStats/settings.dailyRecap |
| usageStats | Open usage stats | tabtivity://settings/usageStats/settings.openUsageStats |
| archive | Archived Projects | tabtivity://settings/archive |
| scaffoldRepair | Repair Project Scaffold | tabtivity://settings/scaffoldRepair |
| agents | Manage CLIs | tabtivity://settings/agents |
| agents | Installed | tabtivity://settings/agents/agents.installedGroup |
| agents | Available to install | tabtivity://settings/agents/agents.availableGroup |
| agents | Accounts & keys | tabtivity://settings/agents/agents.groupAccounts |
| agents | Agent logins | tabtivity://settings/agents/settings.agentLogins |
| agents | API keys | tabtivity://settings/agents/settings.agentApiKeys |
| agents | Anthropic API key | tabtivity://settings/agents/settings.searchProviderKey.anthropic |
| agents | OpenAI API key | tabtivity://settings/agents/settings.searchProviderKey.openai |
| agents | Google Gemini API key | tabtivity://settings/agents/settings.searchProviderKey.google-gemini |
| agents | Global agent config | tabtivity://settings/agents/settings.agentGlobal |
| agents | Copilot sign-in for sandboxed tabs | tabtivity://settings/agents/settings.copilotFenceAuth |
| agents | Claude long-lived token | tabtivity://settings/agents/settings.claudeToken |
| agents | Also use on remote hosts | tabtivity://settings/agents/settings.claudeTokenRemote |
| agents | Agent sandbox | tabtivity://settings/agents/settings.agentFenceTitle |
| agents | Read-only toolchain/config paths (one per line) | tabtivity://settings/agents/settings.agentFencePaths |
| agents | Allow Cargo registry credential files | tabtivity://settings/agents/settings.agentFenceCargoCredentials |
| agents | Root agent reads projects | tabtivity://settings/agents/settings.rootFenceProjects |
| agents | Scheduled warm-up | tabtivity://settings/agents/agentCron.title |
| agents | Send scheduled warm-up messages | tabtivity://settings/agents/agentCron.enable |
| agents | All agents | tabtivity://settings/agents/agentCron.allAgents |
| agents | Tabtivity tools | tabtivity://settings/agents/agents.groupTools |
| agents | Let agents rename their own tab and leave notes (Cockpit MCP) | tabtivity://settings/agents/cockpitMcp.title |
| agents | Offer Tabtivity's help to agent tabs | tabtivity://settings/agents/intro.ask.toggle |
| agents | Let project agents propose scheduled prompts (MCP) | tabtivity://settings/agents/scheduleMcp.title |
| agents | Let project agents ask Tabtivity to push, tag releases and read CI (MCP) | tabtivity://settings/agents/gitPushMcp.title |
| agents | Let project agents ask about your PDF marks (MCP) | tabtivity://settings/agents/markupMcp.title |
| agents | Let project agents ask to print PDFs (MCP) | tabtivity://settings/agents/printMcp.title |
| agents | Let agent tabs of a project message each other (MCP) | tabtivity://settings/agents/tabsMcp.title |
| agents | Root-console tools | tabtivity://settings/agents/agents.tools.root |
| agents | Web tools for Tabby | tabtivity://settings/agents/agents.tools.web |
| agents | Prompt composer | tabtivity://settings/agents/agents.composerHeading |
| agents | Prefix commands | tabtivity://settings/agents/agents.composerCommands |
| agents | Models | tabtivity://settings/agents/agents.composerModels |
| ollama | Ollama Models | tabtivity://settings/ollama |
| ollama | Load on Tabtivity start | tabtivity://settings/ollama/ollama.autostartTitle |
| ollama | Load even in Energy Saver mode | tabtivity://settings/ollama/ollama.autostartInSaver |
| ollama | Local model runtime (Vibe) | tabtivity://settings/ollama/ollama.vibeTitle |
| ollama | Storage | tabtivity://settings/ollama/ollama.storageTitle |
| ollama | Model download location | tabtivity://settings/ollama/ollama.modelLocationTitle |
| pdfMarkup | PDF markup | tabtivity://settings/pdfMarkup |
| pdfMarkup | Apply marks directly | tabtivity://settings/pdfMarkup/settings.pdfMarkupDirect |
| pdfMarkup | Mark up prompt | tabtivity://settings/pdfMarkup/settings.pdfMarkupInstruction |
| pdfMarkup | Questions about your marks | tabtivity://settings/pdfMarkup/markup.ask.label |
| pdfMarkup | “Make these changes” prompt | tabtivity://settings/pdfMarkup/settings.pdfMarkupApply |
| pdfMarkup | Reload the PDF under your marks when it changes | tabtivity://settings/pdfMarkup/settings.pdfMarkupAutoReload |
| pdfMarkup | Hand each Submit to a new subagent | tabtivity://settings/pdfMarkup/settings.pdfMarkupSubagents |
| rootConsole | Root console and MCPs | tabtivity://settings/rootConsole |
| rootConsole | Tabtivity's tools (MCP) for root-console agents | tabtivity://settings/rootConsole/settings.rootMcp |
| rootConsole | Only local models get these tools | tabtivity://settings/rootConsole/settings.rootMcpLocalOnly |
| rootConsole | Agents get Tabtivity's mail tools | tabtivity://settings/rootConsole/settings.rootMcpMail |
| rootConsole | Only local models get the mail tools | tabtivity://settings/rootConsole/settings.rootMcpMailLocalOnly |
| rootConsole | Local models may read the mails you share | tabtivity://settings/rootConsole/settings.rootMcpMailLocalRead |
| rootConsole | Review root-agent writes | tabtivity://settings/rootConsole/rootReview.setting |
| rootConsole | MCP session access | tabtivity://settings/rootConsole/mcpSecurity.title |
| assistant | Tabby, the chat assistant | tabtivity://settings/assistant |
| assistant | Use Tabby | tabtivity://settings/assistant/settings.assistantSwitch |
| assistant | Default CLI | tabtivity://settings/assistant/assistant.settings.defaultCli |
| assistant | Default model | tabtivity://settings/assistant/assistant.settings.defaultModel |
| assistant | Web search | tabtivity://settings/assistant/assistant.settings.search |
| assistant | Search service | tabtivity://settings/assistant/assistant.search.kind |
| voice | Voice | tabtivity://settings/voice |
| voice | Hands-free pause | tabtivity://settings/voice/settings.voice.pause |
| voice | Speech model | tabtivity://settings/voice/settings.voice.model |
| voice | Speech language | tabtivity://settings/voice/settings.voice.lang |
| voice | Languages to pick from | tabtivity://settings/voice/settings.voice.detectLangs |
| voice | Read-aloud speed | tabtivity://settings/voice/settings.voice.rate |
| voice | Natural voice | tabtivity://settings/voice/settings.voice.natural |
| voice | Headset mode | tabtivity://settings/voice/settings.voice.headset |
| voice | Use the GPU | tabtivity://settings/voice/settings.voice.gpu |
| voice | Speech runs on | tabtivity://settings/voice/settings.voice.device |
| remoteFeatures | Remote features | tabtivity://settings/remoteFeatures |
| remoteFeatures | OpenVPN tunnel control | tabtivity://settings/remoteFeatures/settings.vpnEnabled |
| remoteFeatures | Global remote machines | tabtivity://settings/remoteFeatures/settings.machinesEnabled |
| remoteFeatures | Headless remote connections | tabtivity://settings/remoteFeatures/settings.headlessRemote |
| git | Git Hosting | tabtivity://settings/git |
| git | Access token | tabtivity://settings/git/access-token |
| remoteHosts | Remote Connections | tabtivity://settings/remoteHosts |
| vpn | VPN Auto-Connect | tabtivity://settings/vpn |
| vm | Virtual machines | tabtivity://settings/vm |
| vm | QEMU and VM prerequisites | tabtivity://settings/vm/settings.vmPrerequisites |
| vm | Install the missing packages in a tab | tabtivity://settings/vm/projectDialog.vmInstallBtn |
| mobile | Mobile | tabtivity://settings/mobile |
| mobile | Show Mobile connection in header | tabtivity://settings/mobile/settings.mobileIndicator |
| mobile | Only these phones | tabtivity://settings/mobile/mobile.phones.only |
| mobile | Sections on this phone | tabtivity://settings/mobile/mobile.device.sections |
| mobile | Projects on this phone | tabtivity://settings/mobile/mobile.device.projects |
| performance | Power & performance | tabtivity://settings/performance |
| performance | Energy saver | tabtivity://settings/performance/settings.energySaver |
| performance | Fast mode | tabtivity://settings/performance/settings.fastMode |
| performance | Unload hidden tabs after | tabtivity://settings/performance/settings.sleepTabs |
| performance | Shell scrollback | tabtivity://settings/performance/settings.shellScrollback |
| performance | What open tabs hold | tabtivity://settings/performance/settings.tabCosts |
| resourceMonitor | Resource monitor | tabtivity://settings/resourceMonitor |
| resourceMonitor | Show CPU usage | tabtivity://settings/resourceMonitor/settings.showCpu |
| resourceMonitor | Show RAM usage | tabtivity://settings/resourceMonitor/settings.showRam |
| resourceMonitor | Show GPU usage | tabtivity://settings/resourceMonitor/settings.showGpu |
| resourceMonitor | Collapse header status indicators | tabtivity://settings/resourceMonitor/statusCluster.settingLabel |
| experimental | Experimental | tabtivity://settings/experimental |
| experimental | Debug mode | tabtivity://settings/experimental/settings.debug |
| experimental | WebGL terminal renderer | tabtivity://settings/experimental/settings.terminalWebgl |
| experimental | GPU compositing | tabtivity://settings/experimental/settings.gpuCompositing |
| experimental | Windows session host | tabtivity://settings/experimental/settings.windowsSessionHost |
| experimental | Markdown link graph | tabtivity://settings/experimental/settings.mdGraph |
| experimental | Project file remarks | tabtivity://settings/experimental/settings.projectRemarks |
| experimental | GitHub Copilot autocomplete | tabtivity://settings/experimental/settings.copilotCompletion |
| experimental | In-app browser | tabtivity://settings/experimental/settings.webBrowser |
| experimental | Python Run/Debug in the code viewer | tabtivity://settings/experimental/settings.pythonRunDebug |
| experimental | Deck presenter | tabtivity://settings/experimental/settings.deckPresenter |
| experimental | Hands-free voice in the Chat | tabtivity://settings/experimental/settings.voiceHandsFree |
| experimental | Per-turn checkpoints | tabtivity://settings/experimental/settings.turnCheckpoints |

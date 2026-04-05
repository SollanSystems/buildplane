# Buildplane JTBD Customer Interview Guide
### 10-Customer Interview Script — April 2026

> **Purpose:** Reconstruct the decision timeline of developers who have felt the pain of fragmented AI tooling and sought (or rejected) a control plane for autonomous execution.
>
> **Source:** Informed by jtbd.md and 2026-04-04-strategy-memo.md. Reference but don't copy.

---

## 1. Who to Recruit

### Segment A: Power Users of Claude Code / Codex CLI
**Role:** Senior ICs who use terminal-based AI agents daily
**Criteria:**
- Uses Claude Code or Codex CLI at least 4x/week
- Has built custom hooks, prompt files, or `.agent` configurations
- Has experienced lost context between sessions (can describe a specific incident)
- Familiar with worktrees or has felt the need for isolated execution

### Segment B: Team Leads Managing AI-Assisted Developers
**Role:** Tech leads / engineering managers with 3-10 direct reports
**Criteria:**
- At least 2 team members actively use AI coding tools
- Has tried to standardize or govern how the team uses AI agents
- Has dealt with AI-generated code that passed review but caused issues in production
- Evaluates tooling on behalf of the team (budget authority or influence)

### Segment C: Solo Developers Who've Tried Autonomous Agents
**Role:** Independent devs who have used Devin, OpenHands, SWE-agent, or similar
**Criteria:**
- Has tried at least one autonomous code agent beyond standard chat
- Can articulate what worked and what broke down
- Has either continued, paused, or abandoned agent usage (all welcome)
- Writes production code alone or as the primary contributor

### Segment D: Engineering Managers Evaluating AI Tooling for Teams
**Role:** EMs / VP Eng who make purchasing decisions
**Criteria:**
- Responsible for developer productivity metrics or tooling budgets
- Has evaluated or is evaluating AI coding tools beyond GitHub Copilot
- Has concerns about code quality, security, or compliance with AI-generated output
- Manages 5+ engineers who write code

### Segment E: Open-Source Contributors Who've Built Agent Workflows
**Role:** OSS maintainers or contributors who've created prompt systems, agent configs, or agent orchestration patterns
**Criteria:**
- Has built or contributed to SuperClaude, SuperCodex-style setups, or custom agent configs
- Has published agent workflows publicly (GitHub, blog, etc.)
- Thinks about reproducibility, sharing, and composability of agent setups
- Has an audience or network of other agent users

**Target Mix for 10 Interviews:** 2 from each segment minimum. At least 3 who are actively using tools like Buildplane (or close analogs), 4 who are searching/evaluating, 3 who've tried and walked away.

---

## 2. Screener Questions (5-7 questions)

Send these as a form or ask in a 5-minute pre-screen call. Score must be 4/7 or better to qualify.

1. **How often do you use AI coding assistants (Claude Code, Codex CLI, Cursor, Copilot Agent, Devin, etc.)?**
   - Daily (qualifies) / Several times a week (qualifies) / Weekly (qualifies) / Less often (disqualify)

2. **Have you ever lost context or work between AI coding sessions? Can you briefly describe the last time this happened?**
   - If they can describe a specific incident concretely → qualifies. Vague or "no" → disqualify.

3. **Have you ever tried to set up AI agents to work autonomously on a task without you watching every step?**
   - Yes (qualifies) / No but thought about it (qualifies) / No and not interested (disqualify)

4. **Do you currently use or have you used any tool or system to coordinate multiple AI sessions or agents (even if it's just a custom script)?**
   - Yes (qualifies) / No but wanted to (qualifies) / No and don't need to (flag, may still qualify)

5. **What's your primary development environment?**
   - Terminal/CLI-first (strong qualify) / IDE with terminal (qualify) / GUI IDE only (still qualify for segment D)

6. **Roughly how long have you been using AI coding tools in your workflow?**
   - 6+ months (qualifies) / 3-6 months (qualifies) / Less than 3 months (flag — may not have deep enough experience)

7. **Would you be willing to describe a time when AI-generated code caused a problem that you had to fix?**
   - Yes, can describe (qualifies — indicates real stakes) / Happened but don't remember details (flag) / Never happened (disqualify — too early or not using agents for real work)

**Disqualification overrides:** Anyone who only uses AI for casual/exploratory work with no production code involvement. Anyone who can't articulate a specific pain point beyond "it's cool but..." Anyone whose primary language or environment is not supported by Buildplane's current scope (note this for later expansion, not immediate disqualification).

---

## 3. Interview Goals

### Primary Learning Objectives
1. **Trigger moment:** What specific event or frustration first pushed them to look for something better than raw AI agents?
2. **Evaluation criteria:** What did they actually compare? What mattered most in their decision?
3. **The switching moment:** What finally tipped them from "interested" to "installed"?
4. **Retention drivers:** What keeps them using it (or what pushed them away)?
5. **Anxiety and anxiety-reducers:** What fears held them back? What evidence or experience reduced those fears?
6. **Social proof signals:** Whose opinion or what content influenced their decision?
7. **The "little hire" pattern:** When do they choose the control plane over opening Claude Code directly? What makes each choice?

### Secondary Learning Objectives
1. How do they currently handle memory/context persistence between AI sessions?
2. What's their tolerance for setup complexity vs time saved?
3. Do they share or standardize workflows with teammates? How?
4. What would make them recommend this kind of tool to someone else?
5. How do they currently verify AI-generated code before accepting it?

### JTBD Forces to Map Per Interviewer Notes
- **Push:** Document specific frustrations with their current tooling
- **Pull:** Document what attracted them to a control plane approach
- **Anxiety:** Document fears about adopting something new
- **Habit:** Document existing workflows they'd need to abandon

---

## 4. Moderator Intro (30-Second Script)

> "Thanks for making time. Before we start — I want to be clear about what this is and isn't.
>
> I'm [name] from Buildplane. We're building a control plane for autonomous software execution — basically, a system that dispatches AI workers, verifies their output, and remembers what worked so the next run starts smarter.
>
> But this interview isn't about Buildplane. I'm not going to pitch you anything. I want to understand your actual experience: the moment you first realized your current AI tools weren't cutting it, what you did about it, and what worked or didn't. Even if you've never used a tool like ours — or tried one and abandoned it — that's exactly what I want to hear.
>
> There are no wrong answers. If something I ask doesn't apply, just say so — that's useful data too. The whole thing takes about 45 minutes. Sound good?"

---

## 5. Rules for Non-Leading JTBD Interviews

1. **Ask for stories, not opinions.** Not "What would you want?" but "Tell me about the last time you ran into this."
2. **No hypotheticals.** If they say "I would probably...", redirect: "Can you tell me about a time you actually did?"
3. **Don't mention Buildplane after the intro** unless the interviewee brings it up. If they ask, acknowledge briefly but redirect to their experience.
4. **Embrace silence.** After they finish an answer, wait 3-5 seconds. The best insights often come after the pause.
5. **Ask "What happened next?"** constantly. JTBD is a timeline, not a list of opinions.
6. **Listen for the passive voice.** "It just stopped working" → "What specifically stopped? When did you first notice?" Get to the actor.
7. **Don't defend your product.** If they say a feature like theirs sucks, ask "What made it suck for you?" not "Well, ours works differently because..."
8. **Capture exact phrases.** When they use a vivid description of pain or gain, write it verbatim. These become your messaging later.
9. **Probe the negative space.** "Did you consider just doing it manually instead?" "Did anyone on your team push back?" These reveal the real competition.
10. **End every major section with: "Is there anything else about that part of your experience that I haven't asked?"**

---

## 6. Timeline-Based Interview Flow

Each interview follows this arc. Times are approximate. Total: 45 minutes.

| Phase | Time | Focus |
|-------|------|-------|
| **A. Context & First Awareness** | 0-8 min | When did they first feel the pain? What was the trigger? |
| **B. Passive Suffering → Active Search** | 8-15 min | When did they go from tolerating it to looking for solutions? |
| **C. Evaluation & Comparison** | 15-23 min | What did they look at? How did they decide? |
| **D. First Use / Onboarding** | 23-30 min | What was the first real experience like? What surprised them? |
| **E. Repeated Use / Habit Formation** | 30-37 min | When did it become routine? What patterns emerged? |
| **F. Churn, Fallback, or Advocacy** | 37-42 min | Did they stop? Switch back? Recommend? Why? |
| **G. Look Forward** | 42-45 min | What would make this indispensable? What would make them leave? |

**Adaptation by segment:**
- Segment A/B/C → Full flow above
- Segment D (EMs) → Emphasize C, D, F around team adoption and governance
- Segment E (OSS builders) → Emphasize B, C, E around workflow composition and sharing

---

## 7. Core Interview Questions (20+ with Probes)

### PHASE A: Context & First Awareness

**Q1. Walk me through the last time you were using an AI coding agent and hit a wall because of how the session worked (or didn't work).**
- Probe: What were you trying to build or fix?
- Probe: What exactly broke down?
- Probe: How did you recover?
- Probe: Had this happened before, or was this the first time?

**Q2. Think back to before that — when did you first notice that your AI tools were leaving gaps between sessions?**
- Probe: Was it a single moment or a slow build-up?
- Probe: What was the first thing you said out loud or in chat that expressed frustration? **[Capture verbatim]**
- Probe: Did you try to work around it at first? How?

**Q3. What were you doing before AI coding tools entered your workflow? And what changed to make you adopt them?**
- Probe: What's the comparison you make in your head between "then" and "now"?
- Probe: Are there things you won't use AI for, even now? What are they?

### PHASE B: Passive Suffering → Active Search

**Q4. Take me from that first frustration to the first time you actively looked for a solution.**
- Probe: What was the specific moment you went from annoyed to searching?
- Probe: Triggering event: Was it a deadline, a bug, a team issue?
- Probe: Did someone else raise the issue first (manager, teammate, peer)?

**Q5. What were you looking for when you started searching?**
- Probe: Did you have keywords or categories in mind?
- Probe: Were you looking for a specific feature (memory, orchestration, isolation) or just "something better"?
- Probe: Where did you look first? (Twitter, GitHub, blogs, peers, Google?)

**Q6. When you were searching, were you aware of the concept of an AI "control plane" or "orchestration layer"?**
- Probe: Where did you first hear the term, if at all?
- Probe: Did you dismiss it initially? Why or why not?

### PHASE C: Evaluation & Comparison

**Q7. What tools, approaches, or hacks did you seriously consider?**
- Probe: List them. For each, what attracted you?
- Probe: What turned you off?
- Probe: Did you create a formal comparison? A spreadsheet? A mental list?

**Q8. Walk me through your evaluation of the option you ultimately chose (including "doing nothing").**
- Probe: What was the first thing you tried?
- Probe: What specific criteria were you testing against?
- Probe: Who else was involved in the evaluation? What did they say?
- Probe: Did you run a trial project or proof of concept?

**Q9. What was the moment you decided to try it? Not "interested" — actually committed?**
- Probe: What tipped you over?
- Probe: Was there a person, article, demo, or deadline that pushed you?
- Probe: Did you have to convince anyone else? Who, and what did you say?

### PHASE D: First Use / Onboarding

**Q10. Tell me about your first actual run with the tool (or system) you chose.**
- Probe: What task did you pick for the first run and why that one?
- Probe: What happened during setup?
- Probe: What was the moment you realized "this is working" or "this isn't going to work"?
- Probe: How long did it take from install to first meaningful result?

**Q11. What surprised you about that first experience — positively or negatively?**
- Probe: Was there something the documentation didn't tell you?
- Probe: Did you get stuck? On what?
- Probe: Did you ask anyone for help? Where?

**Q12. If you compared that first run to what you were doing before, what was the difference in feel?**
- Probe: Faster? Slower? More confidence? More anxiety?
- Probe: Would you describe the experience as "delegating" or "babysitting"?
- Probe: Did you catch yourself doing something you didn't expect?

### PHASE E: Repeated Use / Habit Formation

**Q13. When did it first become your default choice for a task? Not "sometimes I use it" — it's your go-to.**
- Probe: What was the task? What made you reach for this tool without thinking?
- Probe: How long after the first use did this happen?
- Probe: What was different about that use vs earlier uses?

**Q14. Tell me about a recent time you used it for something real (not a toy project).**
- Probe: What was the task? How complex?
- Probe: Did the system remember anything from previous runs? Did that matter?
- Probe: Did you need to intervene? At what point, and why?
- Probe: Would you trust it with a more critical task? Why or why not?

**Q15. How do you currently handle the handoff between AI-generated outputs and your own code review or merge process?**
- Probe: Do you have a gate or checklist?
- Probe: Has AI output ever slipped through your review? What happened?
- Probe: Do teammates have the same process, or is it just yours?

### PHASE F: Churn, Fallback, or Advocacy

**Q16. Have you ever gone back to the old way (raw Claude Code, manual coding, etc.) after trying a control plane approach?**
- *If yes:*
  - Probe: What specifically made you switch back?
  - Probe: Was it permanent or temporary?
  - Probe: Would you try again? Under what conditions?
- *If no:*
  - Probe: What's the last time you opened a raw agent instead of your system? Why that time?

**Q17. If someone on your team asked you which AI tooling approach you recommend, what would you say?**
- Probe: Would your answer differ for a junior vs senior developer?
- Probe: What caveats would you add?
- Probe: Have you actually recommended it to anyone? What did they do?

### PHASE G: Look Forward

**Q18. Imagine it's 6 months from now and your AI coding workflow is exactly what you need it to be. What does that look like in practice?**
- Probe: What's different from today?
- Probe: What problem no longer exists?
- Probe: How do you describe it to someone who hasn't seen it? **[Capture verbatim for positioning]**

**Q19. What's the one thing that, if it existed, would make you stop shopping around and commit to a tool permanently?**
- Probe: Is this a feature, a result, a feeling, or a social signal?
- Probe: How would you know you have it?

**Q20. What concerns you most about AI coding tools right now — not today's problems, but where things are heading?**
- Probe: Is it about quality, security, jobs, vendor lock-in, something else?
- Probe: How does that concern affect your tool choices today?

### CLOSING

**Q21. Is there anything we haven't talked about that you think matters for understanding how you make decisions about these tools?**

**Q22. If I could ask you one more question in two weeks after you've had more time to think, what should it be?**
*(This reverse question often reveals what the interviewee thinks is the most important unanswered question.)*

---

## 8. Segmentation by User Outcome

Tailor emphasis within the interview flow based on how the interviewee relates to tools like Buildplane. Apply after screening.

### "Hired" — Currently Using Buildplane or Close Analog
**Definition:** Has installed and actively used a control-plane approach (Buildplane, custom orchestration setup, multi-agent pipeline).
**Emphasis in interview:**
- Q10-Q15: Deep dive on actual usage patterns
- Probe for "little hire" moments: When do they choose the control plane vs raw agent?
- Probe for memory carryover: Have they experienced runs that got smarter?
- Probe for verification: Has a quality gate caught something important?
- Probe for team impact: Has their usage influenced teammates?

### "Fired" — Tried and Abandoned
**Definition:** Installed and used a control-plane approach, then stopped. Went back to raw agents or manual workflow.
**Emphasis in interview:**
- Q10-Q12: What went wrong in first use?
- Q16: What was the final straw?
- Probe: Was it the tool, their situation, the task fit, or something else?
- Probe: What would need to change for them to try again?
- **Critical:** Do not defend. Understand the real reason. "It's not you, it's me" is acceptable if backed by evidence.

### "Never-Switched" — Aware but Not Adopted
**Definition:** Knows about control-plane approaches or orchestration concepts but has not installed or used one. Still using raw agents with workarounds.
**Emphasis in interview:**
- Q4-Q6: What keeps them from switching?
- Q7-Q9: What evaluation have they done (even mental)?
- Probe: Is it ignorance of the category, or informed rejection?
- Probe: What's the switching cost in their head?
- Probe: What evidence would they need to see to try it?
- **Critical:** These are your biggest learning opportunity for push/pull/anxiety/habit balance.

---

## 9. Note-Taking Template

Copy this into a blank document for each interview. Fill in during and immediately after (within 1 hour).

```
=== INTERVIEW NOTES ===

Interview ID: BP-JTBD-001
Date: YYYY-MM-DD
Segment: A / B / C / D / E
Interviewer:
Duration: __ minutes

=== INTERVIEWEE CONTEXT ===
Role/Title:
Company size:
Team size:
Primary dev environment:
AI tools currently using:
AI tools previously used:
Autonomous agent experience:
Years using AI coding tools:

=== TIMELINE ===

TRIGGER MOMENT (Q1-Q3):
- First pain point:
- What they were trying to do:
- Specific incident:
- Exact quote:

SEARCH BEHAVIOR (Q4-Q6):
- When passive turned active:
- Where they looked:
- What they searched for:
- Who influenced them:

EVALUATION (Q7-Q9):
- Options considered:
- Decision criteria:
- Tipping point:
- Who else was involved:

FIRST USE (Q10-Q12):
- First task:
- Setup experience:
- First result:
- Surprise (positive/negative):
- Time to value:

REPEATED USE (Q13-Q15):
- When it became default:
- Recent real task:
- Memory carryover experienced?
- Intervention points:
- Review/merge process:

CHURN/FALLBACK (Q16-Q17):
- Has churned? (yes/no/temporary)
- Reason if churned:
- Current fallback:
- Recommendation behavior:

LOOK FORWARD (Q18-Q20):
- 6-month ideal state:
- One thing needed to commit:
- Biggest future concern:

=== JTBD FORCES (post-interview scoring 1-5) ===
Push (frustration with current state): _/5
  Evidence:
Pull (attraction of control plane): _/5
  Evidence:
Anxiety (fear of the new): _/5
  Evidence:
Habit (comfort with current behavior): _/5
  Evidence:

=== LITTLE HIRE PATTERN ===
When they choose control plane:
When they choose raw agent:
When they choose manual work:

=== EXACT QUOTES (verbatim, most vivid 3-5) ===
1.
2.
3.
4.
5.

=== SURPRISES / INSIGHTS ===
-
-
-

=== FOLLOW-UP NEEDED ===
-
-

=== MODERATOR NOTES ===
Pace/interruption issues:
Questions that fell flat:
Areas to probe deeper next time:
```

---

## 10. Synthesis Template

After completing 6+ interviews, fill this in to identify patterns and inform product/marketing decisions.

```
=== BUILDPLANE JTBD INTERVIEW SYNTHESIS ===

Synthesis Date: YYYY-MM-DD
Interviews completed: X of 10
Segments covered: A(X) B(X) C(X) D(X) E(X)
Hired: X | Fired: X | Never-switched: X

=== EXECUTIVE SUMMARY ===
One paragraph: What did we learn about why people seek, adopt, or reject
control planes for autonomous AI execution?

=== PATTERN: JOB TRIGGERS ===
Common first pain points (ranked by frequency):
1.
2.
3.

=== PATTERN: SEARCH BEHAVIOR ===
Where people look:
What they search for:
Who influences them:
Content/assets that mattered:

=== PATTERN: DECISION CRITERIA ===
Top 5 things that matter when choosing a tool (ranked):
1.
2.
3.
4.
5.

=== PATTERN: FORCES OF PROGRESS ===
Average scores across all interviews:
Push: _/5 | Pull: _/5 | Anxiety: _/5 | Habit: _/5
Change formula status: Push + Pull > Habit + Anxiety? (Yes/No/Marginal)

=== PATTERN: LITTLE HIRE ===
When do people reach for the control plane?
When do they fall back to raw agents?
When do they do it manually?

=== PATTERN: RETENTION ===
What keeps people using it:
What drags them away:
The "last straw" stories:

=== MESSAGING GOLD (verbatim quotes) ===
Pain quotes:
1.
2.
3.

Gain quotes:
1.
2.
3.

Positioning-worthy quotes:
1.
2.
3.

=== SEGMENT DIFFERENCES ===
Segment A vs B vs C vs D vs E:
- What differs in triggers?
- What differs in criteria?
- What differs in churn reasons?

=== PRODUCT IMPLICATIONS ===
Features validated by interviews:
Features questioned or rejected:
Missing capabilities mentioned:
Onboarding friction points:

=== NEXT ACTIONS ===
1.
2.
3.
4.
5.

=== CONFIDENCE ===
What are we very confident in? (seen in 5+ interviews)
-

What do we think might be true? (seen in 3-4 interviews)
-

What are we guessing? (seen in 1-2 interviews, needs more data)
-
```

---

## 11. Anti-Patterns to Avoid

### Before the Interview
- **Don't recruit friends or people who know you.** You'll get polite answers, not honest ones.
- **Don't offer compensation tied to positive feedback.** Offer a gift card for time, not for good reviews.
- **Don't send questions in advance.** You want fresh recall, not rehearsed answers.
- **Don't schedule more than 3 interviews per day.** Interviewer fatigue destroys data quality.

### During the Interview
- **Don't say "Buildplane does this."** Not once after the intro. You're listening, not selling.
- **Don't interrupt the story.** Let them ramble. The gold is often in the tangent.
- **Don't ask "Would you pay for X?"** People are bad at predicting future behavior. Ask what they've already paid for.
- **Don't ask "How useful would this feature be?"** Hypotheticals produce worthless data.
- **Don't help them answer.** If they struggle, rephrase. Don't suggest the answer.
- **Don't skip the timeline.** Opinions are cheap. Chronology reveals truth. Always anchor to "What happened next?"
- **Don't focus on features.** Ask about problems, decisions, and outcomes. Features are solutions; you're studying the job.
- **Don't chase confirmation.** If they describe a workflow that contradicts your assumptions, follow it. Don't steer back.

### After the Interview
- **Don't wait to transcribe/summarize.** Fill in the note-taking template within 1 hour. Memory degrades fast.
- **Don't analyze during the interview.** Stay in interviewer mode. Analysis comes after all 10 are done.
- **Don't share individual quotes or notes with the team until synthesized.** Raw notes can bias the team toward anecdotes.
- **Don't skip the synthesis.** Ten interviews without synthesis is ten stories, not data. Force yourself to find patterns.

### JTBD-Specific Anti-Patterns
- **Don't ask "What's your biggest pain point?"** Too abstract. Ask for specific stories with dates.
- **Don't confuse jobs with solutions.** "I want a Buildplane clone" is not a job. "I want my second AI run to know everything the first run learned" is a job.
- **Don't skip the "doing nothing" option.** The biggest competitor is always non-consumption. Ask: "What made manual coding still the right call sometimes?"
- **Don't ignore the hiring manager.** For team purchases, the person who installs and the person who authorizes are different. Interview both if possible.

---

## Appendix A: Recruitment Outreach Templates

### Cold DM / Email (Segment A/C/E — technical users)

> Subject: Quick chat about how you use AI coding tools
>
> Hey [name] — I'm studying how developers are using AI coding agents for real work (not just chat). I came across your [repo/post/config] and was impressed.
>
> I'm doing 10 short interviews (30-45 min) to understand how people decide what tools to use when they're tired of raw agent sessions. No pitch, no product demo — just conversation about your actual experience.
>
> Happy to send a $50 gift card for your time. Interested?
>
> —[name], Buildplane

### Cold DM / Email (Segment B/D — leaders)

> Subject: Research on AI tooling decisions for dev teams
>
> Hi [name] — I'm researching how engineering leaders evaluate and adopt AI coding tools for their teams. I came across your [team/company] and would value your perspective.
>
> I'm conducting 10 interviews (30-45 min) about the real decision-making process — what triggers the search, what you compare, what changes your mind. No sales pitch, no product. Looking to understand how leaders like you think about AI tooling.
>
> Happy to send a $100 gift card for your time. Would you be open to it?
>
> —[name], Buildplane

---

## Appendix B: Interview Logistics Checklist

- [ ] Calendar invite sent with Zoom/Meet link
- [ ] Note-taking template pre-filled with interview ID and segment
- [ ] Recording consent requested and confirmed (if recording)
- [ ] Test audio/video 5 minutes before
- [ ] Have screener results visible for reference
- [ ] Have interview questions printed/visible but don't read robotically
- [ ] Water nearby (interviewer, not interviewee — don't make them wait)
- [ ] Buffer 10 minutes between interviews for notes
- [ ] Backup note-taker assigned if possible (second person takes notes)

---

## Appendix C: Post-Interview Debrief Questions (for Interviewer Self-Reflection)

1. What was the most surprising thing I heard?
2. Where did I struggle to follow the timeline?
3. What question worked best? What question fell flat?
4. Did I inadvertently lead the interviewee at any point?
5. Which JTBD forces feel strongest for this person?
6. Would I hire/fire my product for this person based on what they said? Why?
7. What should I change for the next interview?

---

*Document Version: 1.0 — April 4, 2026*
*Author: Hermes Agent, SollanSystems*
*Source Reference: jtbd.md, 2026-04-04-strategy-memo.md*
*Status: Ready for field use*

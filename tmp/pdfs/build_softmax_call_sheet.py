from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


OUTPUT = Path("/Users/claude/Documents/proxywar_main/output/pdf/softmax_emmett_call_cheat_sheet.pdf")

NAVY = colors.HexColor("#18233A")
BLUE = colors.HexColor("#526C9E")
ORANGE = colors.HexColor("#F3A33C")
INK = colors.HexColor("#202735")
MUTED = colors.HexColor("#626B7A")
PAPER = colors.HexColor("#F7F8FA")
PALE_BLUE = colors.HexColor("#ECF2FA")
PALE_ORANGE = colors.HexColor("#FFF3E2")
PALE_GREEN = colors.HexColor("#EAF6EE")
PALE_RED = colors.HexColor("#FBEDEC")
LINE = colors.HexColor("#D9DEE7")
WHITE = colors.white

PAGE_W, PAGE_H = A4
MARGIN_X = 14 * mm
MARGIN_TOP = 12 * mm
MARGIN_BOTTOM = 12 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_X

styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="DocTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=23,
        leading=26,
        textColor=WHITE,
        alignment=TA_LEFT,
        spaceAfter=0,
    )
)
styles.add(
    ParagraphStyle(
        name="DocSubtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=12,
        textColor=colors.HexColor("#DCE5F3"),
    )
)
styles.add(
    ParagraphStyle(
        name="Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12.5,
        leading=15,
        textColor=NAVY,
        spaceBefore=4,
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="BoxTitle",
        parent=styles["Heading3"],
        fontName="Helvetica-Bold",
        fontSize=9.5,
        leading=11.5,
        textColor=NAVY,
        spaceAfter=3,
    )
)
styles.add(
    ParagraphStyle(
        name="Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8.55,
        leading=11.1,
        textColor=INK,
        spaceAfter=2.5,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyTight",
        parent=styles["Body"],
        fontSize=8.15,
        leading=10.3,
        spaceAfter=1.5,
    )
)
styles.add(
    ParagraphStyle(
        name="Small",
        parent=styles["Body"],
        fontSize=7.5,
        leading=9.4,
        textColor=MUTED,
        spaceAfter=1,
    )
)
styles.add(
    ParagraphStyle(
        name="Quote",
        parent=styles["Body"],
        fontName="Helvetica-Oblique",
        fontSize=9.25,
        leading=12.2,
        textColor=NAVY,
        leftIndent=3,
        rightIndent=2,
        spaceAfter=0,
    )
)
styles.add(
    ParagraphStyle(
        name="Question",
        parent=styles["Body"],
        fontName="Helvetica-Bold",
        fontSize=8.55,
        leading=10.7,
        textColor=BLUE,
        spaceAfter=1.5,
    )
)
styles.add(
    ParagraphStyle(
        name="Footer",
        parent=styles["Small"],
        fontSize=7,
        leading=8,
        textColor=colors.HexColor("#8B93A1"),
        alignment=TA_CENTER,
    )
)


def P(text, style="Body"):
    return Paragraph(text, styles[style])


def bullet(text, style="BodyTight"):
    return Paragraph(f"&bull;&nbsp; {text}", styles[style])


def box(title, flowables, bg=PALE_BLUE, border=LINE, title_color=NAVY, padding=7, width=CONTENT_W):
    title_p = Paragraph(title, ParagraphStyle(
        name=f"InlineTitle{abs(hash((title, str(bg))))}",
        parent=styles["BoxTitle"],
        textColor=title_color,
    ))
    cell = [title_p] + list(flowables)
    table = Table([[cell]], colWidths=[width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, border),
        ("LEFTPADDING", (0, 0), (-1, -1), padding),
        ("RIGHTPADDING", (0, 0), (-1, -1), padding),
        ("TOPPADDING", (0, 0), (-1, -1), padding - 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding - 1),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def two_col(left, right, widths=None, gap=7):
    if widths is None:
        widths = [(CONTENT_W - gap) / 2, (CONTENT_W - gap) / 2]
    table = Table([[left, "", right]], colWidths=[widths[0], gap, widths[1]])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def mini_box(title, body, bg=PALE_BLUE, border=LINE):
    data = [[P(title, "BoxTitle")], [P(body, "BodyTight")]]
    table = Table(data, colWidths=[(CONTENT_W - 7) / 2])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.6, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def header_block(page_label, subtitle):
    content = [
        P("EMMETT CALL - PROXY WAR x SOFTMAX", "DocTitle"),
        Spacer(1, 4),
        P(subtitle, "DocSubtitle"),
    ]
    tag = Table([[P(page_label, "Small")]], colWidths=[38 * mm])
    tag.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ORANGE),
        ("BOX", (0, 0), (-1, -1), 0, ORANGE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    header = Table([[[*content], tag]], colWidths=[CONTENT_W - 42 * mm, 38 * mm])
    header.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
    ]))
    return header


def q_and_a(question, answer):
    content = [
        P(question, "Question"),
        P(answer, "BodyTight"),
        Spacer(1, 3),
    ]
    table = Table([[content]], colWidths=[(CONTENT_W - 7) / 2])
    table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def page_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.45)
    canvas.line(MARGIN_X, 8.5 * mm, PAGE_W - MARGIN_X, 8.5 * mm)
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(colors.HexColor("#8B93A1"))
    canvas.drawString(MARGIN_X, 5.2 * mm, "PRIVATE CALL PREP - factual debrief first, strategy second")
    canvas.drawRightString(PAGE_W - MARGIN_X, 5.2 * mm, f"{doc.page} / 3")
    canvas.restoreState()


story = []

# PAGE 1
story.append(header_block("PAGE 1 - CORE", "One job: give a candid, evidence-bounded account. You are not being examined."))
story.append(Spacer(1, 8))

story.append(box(
    "PRIVATE OBJECTIVE",
    [P(
        "Help Emmett understand what actually happened; learn how Softmax defines participant and publisher success; "
        "resolve the announcement question; and, only if there is real alignment, leave with one concrete next step. "
        "Do not force a design-partner, flagship, acquisition, or consumer-game pitch.",
        "Body",
    )],
    bg=PALE_GREEN,
    border=colors.HexColor("#B9DDC2"),
))
story.append(Spacer(1, 7))

story.append(P("OPEN WITH THIS", "Section"))
story.append(box(
    "",
    [P(
        "Thanks for making the time. I thought the most useful thing would be to walk you through what actually "
        "happened - why I tried Softmax, what worked, what required help from your team, and what happened with "
        "the people I invited. My sample is small, so I will separate what I observed from what I am guessing.",
        "Quote",
    )],
    bg=PALE_ORANGE,
    border=colors.HexColor("#F3C985"),
))
story.append(Spacer(1, 7))

story.append(P("THE 60-SECOND STORY", "Section"))
left_cards = [
    mini_box(
        "1. WHY SOFTMAX",
        "I found Softmax while researching multiplayer agentic games. I was not looking for a platform or planning a deployment. "
        "The model made intuitive sense: containerized policies, repeated evaluations, inspectable replays, and hosted inference.",
        bg=PALE_BLUE,
    ),
    Spacer(1, 6),
    mini_box(
        "3. WHAT HAPPENED",
        "I invited roughly 10-15 warm contacts. Four cloned the repository or started iterating - different levels of activation, "
        "so this is not a clean funnel. Odin is the clearest high-engagement case.",
        bg=PALE_BLUE,
    ),
]
right_cards = [
    mini_box(
        "2. WHAT CHANGED",
        "Softmax turned a local experiment into a shared hosted league where outside policies could compete repeatedly and results "
        "could be inspected. League creation was the only hard operational blocker and required Softmax help.",
        bg=PALE_ORANGE,
        border=colors.HexColor("#F3C985"),
    ),
    Spacer(1, 6),
    mini_box(
        "4. WHAT IS UNCLEAR",
        "The people who tried had coding agents handle setup without meaningful difficulty. The unresolved problem is why more people "
        "should care - and what ultimately accrues to the Coworld publisher if the league succeeds.",
        bg=PALE_ORANGE,
        border=colors.HexColor("#F3C985"),
    ),
]
story.append(two_col(left_cards, right_cards))
story.append(Spacer(1, 8))

story.append(P("EVIDENCE BOUNDARY", "Section"))
obs_w = CONTENT_W * 0.53 - 3.5
hyp_w = CONTENT_W * 0.47 - 3.5
observed = box(
    "OBSERVED",
    [
        bullet("Replays made outcomes inspectable; containers supported isolation and reproducibility; hosted inference removed participant cost."),
        bullet("League creation required Softmax."),
        bullet("10-15 warm invitations; four cloned or began iteration."),
        bullet("Everyone who seriously tried handled setup through coding agents."),
        bullet("Odin engaged deeply and became a top competitor."),
        bullet("Most nonparticipants have not replied to feedback requests."),
    ],
    bg=PALE_GREEN,
    border=colors.HexColor("#B9DDC2"),
    width=obs_w,
)
hyp_unknown = [
    box(
        "REASONABLE HYPOTHESIS",
        [
            bullet("The likely early audience is agent-native, competitive builders."),
            bullet("The main drop-off may occur before setup, when participation is judged worth prioritizing."),
            bullet("Visible rivals, stakes and a healthy seeded field may matter more than simpler installation."),
        ],
        bg=PALE_BLUE,
        width=hyp_w,
    ),
    Spacer(1, 6),
    box(
        "UNKNOWN - DO NOT PRETEND",
        [
            bullet("Why each nonparticipant stopped."),
            bullet("Whether Softmax is already a discovery channel for Proxy War."),
            bullet("Whether Proxy War teaches transferable agent-building skills."),
            bullet("What sustainable value accrues to the publisher."),
        ],
        bg=PALE_RED,
        border=colors.HexColor("#E5B8B5"),
        width=hyp_w,
    ),
]
story.append(two_col(observed, hyp_unknown, widths=[obs_w, hyp_w]))

story.append(PageBreak())

# PAGE 2
story.append(header_block("PAGE 2 - CONVERSATION MAP", "Short answers, the questions that matter, and a clean close."))
story.append(Spacer(1, 8))

story.append(P("LIKELY QUESTIONS - KEEP ANSWERS TO 2-4 SENTENCES", "Section"))
qa_left = [
    q_and_a(
        "WHY DID YOU DEPLOY?",
        "I was not initially looking to deploy it. Softmax made a shared version possible: outside policies could run repeatedly in an "
        "inspectable hosted league instead of everything remaining a local experiment.",
    ),
    q_and_a(
        "WHAT WORKED?",
        "The infrastructure broadly made sense. Setup also worked better than I expected for the actual cohort: participants delegated "
        "Docker, registration and repository instructions to their coding agents.",
    ),
    q_and_a(
        "WHAT WAS BLOCKED?",
        "League creation was the only thing I genuinely could not complete independently. I still do not know whether that is "
        "intentionally managed or eventually meant to be self-service.",
    ),
]
qa_right = [
    q_and_a(
        "WHY DID ODIN SUCCEED?",
        "He was already agent-native, knew how to operate an improvement loop, and enjoys technical competition and games. "
        "Proxy War fit behavior he already had.",
    ),
    q_and_a(
        "WHY DID OTHERS NOT ENGAGE?",
        "I do not know. Most have not replied. It evidently was not salient enough to prioritize, but I cannot distinguish concept, "
        "timing, intimidation or perceived effort from my evidence.",
    ),
    q_and_a(
        "WHAT WOULD YOU CHANGE FIRST?",
        "I would not start by rebuilding onboarding. I would test a clearer reason to participate: a competent seeded field, visible rivals, "
        "a concrete event or challenge, and an immediate path from observing a match to submitting a counter-policy.",
    ),
]
story.append(two_col(qa_left, qa_right))
story.append(Spacer(1, 5))

questions = box(
    "THE QUESTIONS THAT MATTER",
    [
        P("1. Publisher value", "Question"),
        P("I understand why participation improves Softmax's evaluation network. What should accumulate for the Coworld publisher if the environment succeeds?", "BodyTight"),
        P("2. Education", "Question"),
        P("When you describe Softmax as training and education, who is the learner - the policy, its builder, or both? What outcome demonstrates success?", "BodyTight"),
        P("3. Ownership", "Question"),
        P("Which parts of league creation, initial policy seeding, discovery and promotion should Softmax own, and which should the publisher own?", "BodyTight"),
        P("4. Announcement", "Question"),
        P("Should I continue holding off on publicly announcing Proxy War, or should we plan coordinated promotion?", "BodyTight"),
    ],
    bg=PALE_GREEN,
    border=colors.HexColor("#B9DDC2"),
)
story.append(questions)
story.append(Spacer(1, 7))

story.append(box(
    "IF HE ASKS: WHAT DO YOU WANT FROM SOFTMAX?",
    [P(
        "First, candid feedback on who this is really for and what success should mean for a Coworld publisher. Practically, I need a "
        "decision on public promotion. If you believe Proxy War is worth growing, help reaching a few more agent-native competitive builders "
        "or Softmax participation in a tournament would be more useful than generic onboarding work.",
        "Quote",
    )],
    bg=PALE_ORANGE,
    border=colors.HexColor("#F3C985"),
))
story.append(Spacer(1, 7))

story.append(box(
    "CLOSE",
    [P(
        "The most useful thing for me would be clarity on what success should look like for Proxy War as a Coworld and whether we "
        "should now plan a public activation. If you think Proxy War is worth actively growing, what would you want me to do next, "
        "and what could Softmax realistically help with?",
        "Quote",
    )],
    bg=PALE_GREEN,
    border=colors.HexColor("#B9DDC2"),
))
story.append(Spacer(1, 7))
story.append(box(
    "IN-CALL RULES",
    [
        bullet("Answer the question asked and stop after 2-4 sentences."),
        bullet("Use one example, then state the uncertainty."),
        bullet("Let Emmett pull for more detail. Do not turn every observation into a recommendation."),
        bullet("If mentioning a live rank, verify it immediately beforehand or simply say 'highly ranked.'"),
        bullet("Feedback first; personal strategic upside remains private."),
    ],
    bg=PAPER,
))

story.append(PageBreak())

# PAGE 3
story.append(header_block("PAGE 3 - OPTIONAL", "Raise these only if the conversation naturally reaches the topic."))
story.append(Spacer(1, 8))
story.append(P("OPTIONAL PRODUCT BRANCHES", "Section"))
branch_w = (CONTENT_W - 7) / 2
frontend = box(
    "DEDICATED FRONTEND",
    [
        P(
            "Observatory is necessarily a generic evaluation interface. The Proxy War frontend preserves domain identity and makes the "
            "agents' behavior legible. Ask whether Softmax owns the common verification layer while publishers own presentation, community "
            "and the user relationship.",
            "BodyTight",
        ),
        P("Do not say: 'Observatory cheapens the game.'", "Small"),
    ],
    bg=PALE_BLUE,
    width=branch_w,
)
premiere = box(
    "REPLAY PREMIERE",
    [
        P(
            "A sealed match finishes, its result stays hidden, and viewers watch a synchronized replay with predictions, shadow decisions "
            "and discussion. End with: 'Think you can do better? Build a counter.' Humans interact with the evaluation artifact, not the "
            "rated episode.",
            "BodyTight",
        ),
        P("Measure subsequent inspection, policy creation and iteration - not watch time alone.", "Small"),
    ],
    bg=PALE_ORANGE,
    border=colors.HexColor("#F3C985"),
    width=branch_w,
)
story.append(two_col(frontend, premiere, widths=[branch_w, branch_w]))
story.append(Spacer(1, 7))
story.append(box(
    "VISION-SAFE FRAMING",
    [P(
        "I want the human layer around evaluations to produce more inspection, discussion and policy iteration without changing who the "
        "players are. The policies remain the players and the rated evaluation stays sealed. Proxy War can own this engagement layer while "
        "Softmax remains the trusted evaluation substrate.",
        "Quote",
    )],
    bg=PALE_GREEN,
    border=colors.HexColor("#B9DDC2"),
))
story.append(Spacer(1, 7))

story.append(box(
    "EDUCATION - KEEP IT AS A QUESTION, NOT A THESIS",
    [P(
        "A changing league may act as an adaptive practice environment, but there is no evidence yet that OpenFront performance transfers "
        "to ecommerce or general agent-building skill. Do not pitch AI code inspection or educational certification. Ask Emmett who he "
        "believes is learning and what verified reward is meant to teach.",
        "BodyTight",
    )],
    bg=PAPER,
))
story.append(Spacer(1, 7))

bio = box(
    "IF ASKED ABOUT YOU - 40 SECONDS, THEN STOP",
    [P(
        "My background is fairly nonlinear. I was Challenger in League of Legends as a teenager, so competitive games and metagames "
        "have always been a real interest. During university I was involved in political activism in Russia, then completed a joint "
        "management master's at SPbU and LSE. Covid pushed me into crypto, where I ran infrastructure, worked with incentive systems, "
        "invested, led a team of nine, and wrote viral threads about Sybil attacks and airdrop farming. I later became disillusioned with "
        "crypto, and AI became my main interest. Now I am involved in distributed training and building Proxy War - which combines "
        "competitive games, adversarial systems and agents.",
        "BodyTight",
    )],
    bg=PALE_ORANGE,
    border=colors.HexColor("#F3C985"),
)
story.append(bio)
story.append(Spacer(1, 7))

avoid_w = CONTENT_W * 0.58 - 3.5
reset_w = CONTENT_W * 0.42 - 3.5
avoid = box(
    "DO NOT SAY / DO NOT CLAIM",
    [
        bullet("'Docker is blocking users.' The observed cohort handled it."),
        bullet("'The people who did not try were lazy.' No response proves only low salience."),
        bullet("'Observatory cheapens the game.' Say it compresses domain identity."),
        bullet("Containers alone guarantee fairness or research quality."),
        bullet("Rating improvement proves education, or OpenFront skills transfer to ecommerce."),
        bullet("Softmax is already a proven discovery channel for Proxy War."),
        bullet("'I am out of my depth.' Say participant and publisher value are still unclear."),
        bullet("Acquisition, flagship status, or a forced design-partner pitch."),
    ],
    bg=PALE_RED,
    border=colors.HexColor("#E5B8B5"),
    width=avoid_w,
)
reset = box(
    "IF YOU FREEZE",
    [
        P("Give me a second to think about that.", "Quote"),
        Spacer(1, 3),
        P("My initial assumption was X, but what I observed now points more toward Y.", "Quote"),
        Spacer(1, 3),
        P("I do not have enough evidence to distinguish those explanations yet.", "Quote"),
        Spacer(1, 3),
        P("That is one of the things I was hoping to understand from you.", "Quote"),
    ],
    bg=PAPER,
    width=reset_w,
)
story.append(two_col(avoid, reset, widths=[avoid_w, reset_w]))


OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc = SimpleDocTemplate(
    str(OUTPUT),
    pagesize=A4,
    rightMargin=MARGIN_X,
    leftMargin=MARGIN_X,
    topMargin=MARGIN_TOP,
    bottomMargin=MARGIN_BOTTOM,
    title="Emmett Call - Proxy War x Softmax",
    author="Private call preparation",
    subject="Evidence-bounded call cheat sheet",
)
doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)
print(OUTPUT)

"""Ten sample models, built with the simulated teachers through shrewd's public API.

    shrewd-studio --sandbox --samples --workspace samples

Each sample is an ordinary run folder stopped at a stage worth looking at, with synthetic
documents from its own domain. Every document has a known answer, so the simulated teachers
can be right or wrong in realistic ways, and a few hand labels are slips, as real ones are.

    Ticket routing        classifier, one teacher                  shipped with teacher backup
    Review sentiment      classifier, two teachers, majority       ties waiting in review
    News topics           classifier, three teachers, weighted     methods compared, one shipped
    Booking intent        classifier, one teacher asked 3 times    vote splits in review
    Lead qualification    classifier, labeled under a budget       paused at 400 of 600
    Feedback themes       classifier, two teachers                 examples only
    Content moderation    panel, one teacher                       shipped with teacher backup
    Contract clauses      panel, two teachers                      review waiting
    PII check             panel, three teachers, cheapest first    shipped with teacher backup
    Job postings          panel, two teachers                      checked, ready to label
"""

import json
import random
from pathlib import Path

import pandas as pd

from shrewd_studio import sandbox

HAIKU, GPT, FABLE = "anthropic/claude-haiku-5-5", "openai/gpt-5.1", "anthropic/claude-fable-5-1"


def _make(n, seed, one):
    """`n` distinct documents from `one(rng)`, which returns a text and its answers."""
    rng = random.Random(seed)
    rows = {}
    for _ in range(n * 20):
        if len(rows) >= n:
            break
        row = one(rng)
        rows.setdefault(row["text"], row)
    return pd.DataFrame(list(rows.values()))


def _slip(frame, rng_seed, columns, options, rate=0.03):
    """Hand labels with the occasional slip, the way a person labels a few hundred."""
    rng = random.Random(rng_seed)
    out = frame.copy()
    for i in out.index:
        for column in columns:
            if rng.random() < rate:
                out.loc[i, column] = rng.choice([o for o in options[column]
                                                 if o != out.loc[i, column]])
    return out


# ---------------------------------------------------------------- classifiers


TICKETS = {
    "billing": ["I was charged twice for order {n}", "my invoice {n} shows the wrong amount",
                "please refund the {m} charge from last week", "why was my card billed again",
                "the annual plan price on my receipt is wrong",
                "my coupon wasn't applied at checkout"],
    "technical": ["the app crashes when I open settings", "export to CSV fails with error {n}",
                  "the dashboard won't load on Safari", "push notifications stopped on my phone",
                  "search returns nothing for exact names", "uploading a photo gives an error 500"],
    "shipping": ["my package {n} says delivered but nothing arrived",
                 "tracking for order {n} hasn't moved in a week", "do you ship to {place}",
                 "the box arrived crushed and the item is broken",
                 "can I change my delivery address",
                 "my parcel went to the wrong city"],
    "account": ["I can't log in, the reset email never arrives",
                "how do I change the email on my profile",
                "my account got locked after too many attempts",
                "please add my colleague as an admin",
                "two-factor codes aren't being accepted", "how do I delete my account"],
    "other": ["what are your support hours on weekends", "is there a student discount",
              "do you have an Android app", "just wanted to say the new design is lovely",
              "where can I find your API documentation", "are you hiring in {place}"],
}
PLACES = ["Iceland", "Portugal", "Chile", "Kenya", "Vietnam", "Canada", "Norway", "Peru"]


def ticket(rng):
    label = rng.choices(list(TICKETS), weights=[28, 26, 20, 16, 10])[0]
    core = rng.choice(TICKETS[label]).format(n=rng.randint(1000, 9999), m=rng.choice(
        ["March", "April", "May"]), place=rng.choice(PLACES))
    text = rng.choice(["", "Hi, ", "Hello, ", "Quick question: ", "Hey team, "]) + core
    hard = rng.random() < 0.18
    if hard:  # a second topic in passing, where the teachers slip
        other = rng.choice([k for k in TICKETS if k != label])
        text += ", and " + rng.choice(TICKETS[other]).format(
            n=rng.randint(1000, 9999), m="June", place=rng.choice(PLACES)).lower()
    text += rng.choice([".", ". Thanks.", "!", ". Please help.", ". This is urgent."])
    return {"text": text[0].upper() + text[1:], "label": label, "_hard": hard}


ASPECTS = {
    "positive": ["the battery lasts all week", "it was easy to set up", "the sound is crisp",
                 "the build feels solid", "delivery was quick", "it looks great on my desk",
                 "support answered within an hour"],
    "negative": ["it stopped working after two weeks", "the screen scratches easily",
                 "the app keeps disconnecting", "it arrived with a dent",
                 "the instructions were useless", "it runs hot after ten minutes",
                 "the strap broke on day three"],
    "neutral": ["it does what it says", "it comes in a plain box",
                "it is about the size I expected",
                "the color matches the photos", "it uses a standard charger",
                "I've had it for a month"],
}
PRODUCTS = ["headphones", "kettle", "desk lamp", "keyboard", "phone case", "blender",
            "smartwatch", "backpack", "speaker", "air fryer"]


def review(rng):
    label = rng.choices(["positive", "negative", "mixed", "neutral"], weights=[35, 30, 20, 15])[0]
    product = rng.choice(PRODUCTS)
    if label == "mixed":
        good, poor = rng.choice(ASPECTS["positive"]), rng.choice(ASPECTS["negative"])
        body = f"{good}, but {poor}" if rng.random() < 0.5 else f"{poor}, though {good}"
    else:
        body = " and ".join(rng.sample(ASPECTS[label], 2))
    tail = {"positive": ["Would buy again.", "Five stars.", "Really happy with it."],
            "negative": ["Returning it.", "Not worth the money.", "Disappointed."],
            "mixed": ["Mixed feelings.", "Three stars.", "Hard to say."],
            "neutral": ["", "Fine.", "No complaints so far."]}[label]
    text = f"The {product}: {body}. {rng.choice(tail)}".strip()
    return {"text": text, "label": label, "_hard": label == "mixed"}


HEADLINES = {
    "politics": ["Parliament passes {adj} data protection bill",
                 "Minister resigns over {topic} funding row", "Coalition talks stall in {place}",
                 "Senate votes to extend {topic} inquiry", "Opposition leader calls snap vote"],
    "business": ["Central bank holds rates as growth slows in {place}",
                 "Chipmaker shares jump after {adj} quarter", "Retailer to close 40 stores",
                 "{topic} startup raises funding round", "Airline profits beat forecasts"],
    "sport": ["Striker signs three-year deal with champions",
              "{place} wins the relay in a photo finish",
              "Coach sacked after {adj} run of defeats", "Marathon record falls in {place}",
              "Tennis star withdraws with an injury"],
    "science": ["Telescope captures earliest known galaxy cluster",
                "{adj} vaccine trial shows early promise", "Researchers map the {topic} genome",
                "Probe sends first images from the moon's far side",
                "New species of frog found in {place}"],
    "culture": ["Festival lineup announced for the summer",
                "Gallery sale sets record for living artist",
                "{place} museum returns looted artifacts", "Novel about {topic} wins top prize",
                "Film director's {adj} epic opens to acclaim"],
}
ADJ = ["sweeping", "surprise", "long-awaited", "disappointing", "record", "controversial"]
TOPICS = ["stadium", "wheat", "coral", "battery", "railway", "honeybee", "satellite"]


def headline(rng):
    label = rng.choice(list(HEADLINES))
    text = rng.choice(HEADLINES[label]).format(adj=rng.choice(ADJ), topic=rng.choice(TOPICS),
                                               place=rng.choice(PLACES))
    if rng.random() < 0.3:
        text += rng.choice([f" ({rng.choice(PLACES)})", f", {rng.randint(2, 28)} May",
                            " - live updates",
                            f", say {rng.choice(['analysts', 'officials', 'fans'])}"])
    return {"text": text, "label": label}


INTENTS = {
    "book": ["table for {k} on {day} at {t}", "can I reserve a double room for {day}",
             "I'd like to book {k} nights from {day}", "do you have space for {k} people {day}"],
    "cancel": ["please cancel my booking for {day}", "I need to cancel, we can't make it {day}",
               "cancel reservation {ref} and refund me", "we won't be coming {day}, cancel it"],
    "change": ["can I move my booking to {day}", "please change our table from {k} to {k2} people",
               "could we arrive at {t} instead", "switch reservation {ref} to {day}"],
    "question": ["do you allow dogs", "is breakfast included", "is parking free for guests",
                 "what time is check-out", "do you have a vegan menu"],
    "complaint": ["the room on {day} was dirty", "we waited an hour for our food {day}",
                  "why was I charged a no-show fee", "the staff were rude when we arrived"],
}
DAYS = ["Friday", "Saturday", "Sunday", "next Tuesday", "the 14th", "tomorrow"]


def booking(rng):
    label = rng.choices(list(INTENTS), weights=[30, 18, 18, 22, 12])[0]
    text = rng.choice(INTENTS[label]).format(k=rng.randint(2, 8), k2=rng.randint(2, 8),
                                             day=rng.choice(DAYS), t=rng.choice(["7pm", "8:30",
                                                                                  "noon"]),
                                             ref=f"R{rng.randint(100, 999)}")
    hard = rng.random() < 0.2
    if hard:  # two intents in one message, where votes split
        other = rng.choice([k for k in INTENTS if k != label])
        text += ", also " + rng.choice(INTENTS[other]).format(
            k=3, k2=4, day=rng.choice(DAYS), t="9pm", ref="R100")
    text = text[0].upper() + text[1:] + rng.choice(["?", ".", ", thanks.", "!"])
    return {"text": text.replace("?,", ","), "label": label, "_hard": hard}


def lead(rng):
    label = rng.choices(["qualified", "nurture", "disqualify"], weights=[30, 40, 30])[0]
    who = {"qualified": ["a {n}-person team", "an enterprise with {k},000 staff",
                         "a {n}-person agency", "the ops lead at a {n}-person retailer"],
           "nurture": ["a growing team of {n}", "a small studio", "a {n}-person company",
                       "a founder with {n} employees"],
           "disqualify": ["a student", "a solo hobbyist", "a two-person side project",
                          "a consultant"]}[label]
    need = {"qualified": ["evaluating vendors this quarter", "need pricing for a rollout in {m}",
                          "want a demo for our team next week", "have budget approved for {m}"],
            "nurture": ["curious to learn more", "budget opens in {m} next year",
                        "just exploring options", "might revisit after our reorg"],
            "disqualify": ["looking for something free", "researching tools for a class project",
                           "not planning to buy", "selling SEO services to you"]}[label]
    text = f"We're {rng.choice(who)}, {rng.choice(need)}.".format(
        n=rng.randint(12, 400), k=rng.randint(2, 9), m=rng.choice(
            ["March", "June", "September", "Q3", "Q4"]))
    if rng.random() < 0.6:
        text += rng.choice([" Saw your talk.", " Found you on a podcast.", " Referred by a friend.",
                            f" Based in {rng.choice(PLACES)}.", f" Ticket {rng.randint(1, 999)}."])
    return {"text": text, "label": label}


FEEDBACK = {
    "pricing": ["too expensive for a small team", "the per-seat price adds up fast",
                "wish there was a cheaper tier", "the price jump at renewal surprised us"],
    "performance": ["search takes forever on big projects", "the editor lags when typing",
                    "exports time out on large files", "the app is slow to start"],
    "missing feature": ["please add dark mode", "we need an export to PDF", "add a calendar view",
                        "single sign-on would help a lot"],
    "praise": ["honestly the best tool we use", "the new design is lovely",
               "support has been fantastic", "it saves me an hour a day"],
    "other": ["how do I contact sales", "our trial ended early", "is there a status page",
              "who do I invoice"],
}


def feedback(rng):
    label = rng.choice(list(FEEDBACK))
    text = rng.choice(FEEDBACK[label])
    text = rng.choice(["", "Feedback: ", "Honestly, ", "One thing: "]) + text
    text = text[0].upper() + text[1:] + rng.choice([".", "!", ". Thanks.",
                                                    f" ({rng.randint(1, 99)})"])
    return {"text": text, "label": label}


# ---------------------------------------------------------------- panels


COMMENTS = {
    "harassment": ["you're an idiot and everyone knows it", "nobody here likes you, leave",
                   "I'll find where you live"],
    "hate": ["people like you shouldn't be allowed to vote", "your kind ruins every neighborhood"],
    "self-harm": ["nobody would miss me if I was gone", "I don't see the point of going on"],
    "spam": ["buy followers cheap, link in bio", "free crypto giveaway, DM now",
             "earn $500 a day from home, click here"],
    "none": ["great match last night, what a finish", "this recipe is a crime against pasta",
             "does anyone know when the store opens", "loved the photos from the trip",
             "the referee was terrible but we still won"],
}
HARSH = ("crime", "terrible", "idiot")


def comment(rng):
    category = rng.choices(list(COMMENTS), weights=[14, 8, 6, 14, 58])[0]
    text = rng.choice(COMMENTS[category])
    if category == "none":
        severity = "none"
    elif category == "spam":
        severity = "mild"
    elif category in ("hate", "self-harm") or "find where you live" in text:
        severity = "severe"
    else:
        severity = rng.choice(["mild", "severe"])
        text += "!!!" if severity == "severe" else ""
    text = text[0].upper() + text[1:] + rng.choice(["", ".", " lol", f" #{rng.randint(1, 999)}",
                                                    " 🙄", f" @user{rng.randint(10, 99)}"])
    return {"text": text, "harmful": "no" if category == "none" else "yes",
            "category": category, "severity": severity,
            "_hard": category == "harassment" or any(w in text for w in HARSH)}


CLAUSES = [
    ("termination", "yes", "low", "Either party may terminate with {d} days' written notice"),
    ("termination", "no", "medium",
     "This Agreement renews automatically unless cancelled {d} days before term end"),
    ("termination", "no", "high", "Supplier may terminate immediately for any reason"),
    ("liability", "no", "medium",
     "Supplier's total liability shall not exceed fees paid in the prior {d} months"),
    ("liability", "yes", "low", "Neither party is liable for indirect or consequential damages"),
    ("liability", "no", "high", "Customer shall indemnify Supplier against all third-party claims"),
    ("payment", "yes", "low", "Invoices are payable within {d} days of receipt"),
    ("payment", "no", "medium", "Late payments accrue interest at {p}% per month"),
    ("payment", "no", "high", "Supplier may raise prices at any time without notice"),
    ("confidentiality", "yes", "low",
     "Recipient shall keep Confidential Information secret for {d} years"),
    ("confidentiality", "no", "medium", "Supplier may disclose Customer data to its affiliates"),
    ("other", "no", "high", "Supplier may assign this Agreement without consent"),
    ("other", "yes", "low", "This Agreement is governed by the laws of {place}"),
]


def clause(rng):
    kind, favorable, risk, template = rng.choice(CLAUSES)
    text = template.format(d=rng.choice([10, 14, 30, 45, 60, 90]), p=rng.choice([1, 1.5, 2]),
                           place=rng.choice(PLACES))
    if rng.random() < 0.4:
        text = rng.choice(["Section {s}. ", "{s}.1 ", "Clause {s}: "]).format(
            s=rng.randint(2, 19)) + text
    return {"text": text + ".", "clause_type": kind, "favorable": favorable, "risk": risk}


PII = [
    ("contact", "medium", "Call me on 0412 555 {n} after 5"),
    ("contact", "low", "Send the invoice to {name}@acme.io"),
    ("contact", "medium", "My address is {n} Harbour Street, flat 2"),
    ("financial", "medium", "My card ending {n} was declined"),
    ("financial", "high", "IBAN GB29 NWBK 6016 1331 {n} for the refund"),
    ("identity", "high", "Passport number X12{n} for the booking"),
    ("identity", "medium", "My date of birth is {n} March 1987"),
    ("credentials", "high", "Password is hunter{n}, don't tell anyone"),
    ("credentials", "high", "The API key is sk-live-{n}abc"),
    ("none", "low", "Meeting moved to 3pm, room {n}"),
    ("none", "low", "The weather is lovely today, {name}"),
    ("none", "low", "Lunch order: {n} sandwiches and a salad"),
]
NAMES = ["jane", "omar", "li", "sofia", "tom", "ana", "raj", "mia"]


def pii(rng):
    kind, risk, template = rng.choice(PII)
    text = template.format(n=rng.randint(10, 9999), name=rng.choice(NAMES))
    if rng.random() < 0.3:
        text = rng.choice(["Hi! ", "FYI: ", "Note to self: ", "Re: your email. "]) + text
    return {"text": text + ".", "contains_pii": "no" if kind == "none" else "yes",
            "kind": kind, "share_risk": risk,
            "_hard": "{name}" in template or "birth" in template}


ROLES = {
    "engineering": ["backend engineer", "ML engineer", "site reliability engineer",
                    "iOS developer"],
    "sales": ["account executive", "sales development rep", "partnerships manager"],
    "design": ["product designer", "brand designer", "UX researcher"],
    "operations": ["warehouse operations lead", "office manager", "supply chain analyst"],
    "other": ["legal counsel", "community manager", "executive assistant"],
}
LEVELS = {"junior": ["Junior", "Entry-level", "Graduate"], "mid": ["", "Mid-level", ""],
          "senior": ["Senior", "Staff", "Lead"]}


def posting(rng):
    function = rng.choice(list(ROLES))
    seniority = rng.choice(list(LEVELS))
    remote = rng.choice(["yes", "no"])
    where = (rng.choice(["fully remote", "remote within the EU", "remote-first team"])
             if remote == "yes" else
             rng.choice(["on-site in Austin", "hybrid in Berlin", "NYC office", "on-site"]))
    years = {"junior": "0-2 years", "mid": "3+ years", "senior": "8+ years"}[seniority]
    title = f"{rng.choice(LEVELS[seniority])} {rng.choice(ROLES[function])}".strip()
    text = f"{title[0].upper() + title[1:]}, {where}, {years}"
    if rng.random() < 0.5:
        text += rng.choice([", Go and Postgres", ", equity", ", visa sponsorship",
                            f", from ${rng.randint(60, 220)}k"])
    return {"text": text + ".", "remote": remote, "seniority": seniority, "function": function}


def _panel_questions(name):
    from shrewd.decide import Choice, Noul, Score

    return {
        "moderation": {
            "harmful": Noul(instructions="Is this comment harmful to someone?"),
            "category": Choice(instructions="What kind of comment is it?", criteria={
                "harassment": "insults or threats aimed at a person", "hate": "attacks a group",
                "self-harm": "the writer may hurt themselves", "spam": "advertising or scams",
                "none": "an ordinary comment"}),
            "severity": Score(instructions="How severe is it?",
                              criteria=["none", "mild", "severe"]),
        },
        "clauses": {
            "clause_type": Choice(instructions="What does the clause govern?", criteria={
                "liability": "who pays for damages", "termination": "how the contract ends",
                "payment": "prices and invoices", "confidentiality": "keeping information secret",
                "other": "anything else"}),
            "favorable": Noul(instructions="Is the clause favorable to us as the customer?"),
            "risk": Score(instructions="How much risk does it carry for us?",
                          criteria=["low", "medium", "high"]),
        },
        "pii": {
            "contains_pii": Noul(instructions="Does the text contain personal information?"),
            "kind": Choice(instructions="What kind of personal information?", criteria={
                "contact": "phone, email or address", "financial": "card or bank details",
                "identity": "ID numbers, date of birth", "credentials": "passwords or keys",
                "none": "no personal information"}),
            "share_risk": Score(instructions="How risky is sharing it with a third party?",
                                criteria=["low", "medium", "high"]),
        },
        "jobs": {
            "remote": Noul(instructions="Can the job be done fully remotely?"),
            "seniority": Score(instructions="How senior is the role?",
                               criteria=["junior", "mid", "senior"]),
            "function": Choice(instructions="Which function is it in?", criteria={
                "engineering": "builds software", "sales": "sells", "design": "designs",
                "operations": "runs the business day to day", "other": "anything else"}),
        },
    }[name]


# ---------------------------------------------------------------- building


def _methods():
    from shrewd_studio.views import installed

    return ["tfidf"] + (["embed"] if installed("embed") else [])


def _start(frame, columns, options, size, seed):
    """Register the true answers with the simulated teachers and split the documents into
    hand-labeled examples (with a few slips) and the pool."""
    keep = columns + (["_hard"] if "_hard" in frame.columns else [])
    truth = {row["text"]: {c: row[c] for c in keep} for row in frame.to_dict("records")}
    sandbox.register(truth)
    examples = _slip(frame.iloc[:size], seed, columns, options)
    pool = frame.iloc[size:][["text"]]
    return truth, examples, pool


def _classifier(root, slug, name, instructions, labels, teacher, data, sizes, seed):
    from shrewd import Project

    path = root / slug
    frame = _make(sum(sizes), seed, data)
    truth, examples, pool = _start(frame, ["label"], {"label": list(labels)}, sizes[0], seed)
    p = Project(path, instructions=instructions, labels=labels, teacher=teacher)
    p.add_seed(examples[["text", "label"]])
    (path / "prompt.txt").write_text(_seed_prompt(instructions, labels))
    _finish_files(path, name, pool)
    return p, pool, truth


def _panel(root, slug, name, instructions, questions, teacher, data, sizes, seed):
    from shrewd import Decisions

    path = root / slug
    frame = _make(sum(sizes), seed, data)
    options = {k: [str(o) for o in (q.criteria if q.kind == "score" else q.options())]
               for k, q in questions.items()}
    truth, examples, pool = _start(frame, list(questions), options, sizes[0], seed)
    d = Decisions(path, questions=questions, instructions=instructions, teacher=teacher)
    d.add_seed(examples[["text", *questions]])
    _finish_files(path, name, pool)
    return d, pool, truth


def _finish_files(path, name, pool):
    if len(pool):
        pool.to_csv(path / "pool_input.csv", index=False)
    (path / "studio.json").write_text(json.dumps({"name": name}, indent=2))


def _task(lib, **task):
    """Studio's labeling settings for a sample, as the Task drawer would save them."""
    from shrewd_studio.workspace import Run

    Run(lib.dir).save_meta(task=task)


def _ship(lib, method, **kwargs):
    from shrewd import Project

    if isinstance(lib, Project):
        lib.compare(students=_methods())
        lib.distill(student=method, **kwargs)
    else:
        lib.compare(features=_methods())
        lib.distill(features=method, **kwargs)


def tickets(root):
    p, pool, truth = _classifier(
        root, "tickets", "Ticket routing",
        "Route each support ticket to the team that should handle it.",
        {"billing": "charges, invoices, refunds", "technical": "something is broken",
         "shipping": "deliveries and parcels", "account": "login, profile, access",
         "other": "anything else"}, HAIKU, ticket, (300, 1100), 11)
    p.check_teachers()
    p.label(pool)
    _ship(p, "tfidf", route_budget=0.05)
    return truth


def sentiment(root):
    p, pool, truth = _classifier(
        root, "sentiment", "Review sentiment",
        "Classify the overall sentiment of each product review.",
        {"positive": "the reviewer is happy", "negative": "the reviewer is unhappy",
         "mixed": "both praise and complaints", "neutral": "neither"},
        [HAIKU, GPT], review, (260, 700), 12)
    p.check_teachers()
    p.label(pool)
    queue = pd.read_csv(p.dir / "needs_review.csv")
    p.review([{"text": t, "label": truth[t]["label"]} for t in queue["text"].head(3)])
    return truth


def news(root):
    p, pool, truth = _classifier(
        root, "news", "News topics", "Assign each headline to its main topic.",
        {"politics": "government and elections", "business": "companies and markets",
         "sport": "games and athletes", "science": "research and discovery",
         "culture": "arts, books, film"}, [HAIKU, GPT, FABLE], headline, (400, 900), 13)
    p.check_teachers()
    p.label(pool, combine="weighted")
    _ship(p, "tfidf")
    return truth


def intent(root):
    p, pool, truth = _classifier(
        root, "intent", "Booking intent", "What does the guest want to do?",
        {"book": "make a new booking", "cancel": "cancel a booking",
         "change": "change an existing booking", "question": "asks something",
         "complaint": "unhappy about something"}, HAIKU, booking, (250, 600), 14)
    p.check_teachers(votes=3)
    p.label(pool, votes=3)
    _task(p, votes=3)
    return truth


def leads(root):
    from shrewd_studio import jobs

    p, pool, truth = _classifier(
        root, "leads", "Lead qualification", "Is this inbound message a sales-qualified lead?",
        {"qualified": "a real buyer with a need and a budget",
         "nurture": "interested, not ready", "disqualify": "not a buyer"},
        HAIKU, lead, (200, 900), 15)
    p.check_teachers()
    p.label(pool, n=400)
    limit = {"mode": "n", "value": 600}
    _task(p, limit=limit)
    # labeling toward 600 was paused at 400: resuming runs label(n=600), which
    # continues from the 400 already labeled
    rounds = len(json.loads((p.dir / "label_log.json").read_text()))
    jobs.add_record(root, jobs.Job(
        model="leads", model_name="Lead qualification", kind="label",
        title="Labeling, up to 600", uses="API", state="paused", progress=round(400 / 600, 4),
        message=f"Paused after round {rounds}, 400 labeled",
        params={"votes": 1, "limit": limit, "concurrency": 8, "combine": None,
                "escalate": None}))
    return truth


def themes(root):
    _, _, truth = _classifier(
        root, "themes", "Feedback themes", "Sort product feedback by theme.",
        {"pricing": "", "performance": "", "missing feature": "", "praise": "", "other": ""},
        [HAIKU, GPT], feedback, (200, 0), 16)
    return truth


def moderation(root):
    d, pool, truth = _panel(
        root, "moderation", "Content moderation", "User comments posted on a public forum.",
        _panel_questions("moderation"), FABLE, comment, (320, 1000), 21)
    d.check_teachers()
    d.judge(pool)
    _ship(d, _methods()[-1], route_budget=0.05)
    return truth


def clauses(root):
    d, pool, truth = _panel(
        root, "clauses", "Contract clauses",
        "Clauses from supplier contracts, read from our side as the customer.",
        _panel_questions("clauses"), [HAIKU, FABLE], clause, (230, 600), 22)
    d.check_teachers()
    d.judge(pool)
    return truth


def pii_check(root):
    d, pool, truth = _panel(
        root, "pii", "PII check", "Text a user is about to send to a third-party service.",
        _panel_questions("pii"), [HAIKU, GPT, FABLE], pii, (320, 1000), 23)
    d.check_teachers()
    d.judge(pool, escalate=0.05)
    _ship(d, "tfidf", route_budget=0.05)
    return truth


def postings(root):
    d, _, truth = _panel(
        root, "jobs", "Job postings", "Job postings scraped from company career pages.",
        _panel_questions("jobs"), [HAIKU, GPT], posting, (250, 1200), 24)
    d.check_teachers()
    return truth


SAMPLES = {"tickets": tickets, "sentiment": sentiment, "news": news, "intent": intent,
           "leads": leads, "themes": themes, "moderation": moderation, "clauses": clauses,
           "pii": pii_check, "jobs": postings}


def _build_one(root, slug):
    """One sample, in its own process: quiet, with the simulated teachers installed."""
    import contextlib
    import io

    sandbox.install()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return SAMPLES[slug](Path(root))


def build(workspace):
    """Create every sample in `workspace` that isn't there yet, several at once. Returns
    the folders made."""
    import os
    from concurrent.futures import ProcessPoolExecutor

    root = Path(workspace).resolve()
    root.mkdir(parents=True, exist_ok=True)
    todo = [slug for slug in SAMPLES if not (root / slug).exists()]
    if not todo:
        return []
    truth_path = root / ".sandbox_truth.json"
    truth = json.loads(truth_path.read_text()) if truth_path.exists() else {}
    with ProcessPoolExecutor(max_workers=min(len(todo), os.cpu_count() or 2)) as pool:
        for made in pool.map(_build_one, [str(root)] * len(todo), todo):
            truth.update(made)
    truth_path.write_text(json.dumps(truth))
    sandbox.register(truth)
    return todo


def _seed_prompt(instructions, labels):
    from shrewd.optimize import build_seed_prompt

    return build_seed_prompt(instructions, labels)

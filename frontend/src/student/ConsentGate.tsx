import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "nexus_consent_seen_v1";

interface CalibrationPair {
  id: "A" | "B";
  neutral: { urdu: string; translation: string };
  high: { urdu: string; translation: string };
  expectedHigh: "B";
  observations: string[];
}

const CALIBRATION_PAIRS: CalibrationPair[] = [
  {
    id: "A",
    expectedHigh: "B",
    neutral: {
      urdu: "حکومت نے نئے قانون کی منظوری دے دی، جس پر مختلف حلقوں کی جانب سے ملا جلا ردعمل سامنے آیا۔",
      translation: "The government approved the new law, which drew a mixed response from various circles.",
    },
    high: {
      urdu: "حکومت نے عوام کی مرضی کے خلاف متنازعہ قانون زبردستی مسلط کر دیا، جس سے ملک بھر میں شدید غم و غصہ پھیل گیا۔",
      translation:
        "The government forcibly imposed the controversial law against the people's will, sparking intense outrage nationwide.",
    },
    observations: [
      "Loaded verb: زبردستی مسلط (forcibly imposed) asserts force rather than reporting approval.",
      "Unverified scope: عوام کی مرضی کے خلاف claims to speak for public consensus.",
      "Emotional scope: ملک بھر میں شدید غم و غصہ is not attributed to named sources.",
    ],
  },
  {
    id: "B",
    expectedHigh: "B",
    neutral: {
      urdu: "معیشت میں نئی پالیسیوں کے بعد نرخِ سرمایہ کاری میں معمولی اضافہ دیکھا گیا ہے۔",
      translation:
        "After the new economic policies, a modest increase in the investment rate has been observed.",
    },
    high: {
      urdu: "ماہرین کا واضح کہنا ہے کہ پالیسیوں نے معیشت کو تباہ کر دیا ہے اور ملک کو گہرے تباہی کی دہلیز پر کھڑا کر دیا ہے۔",
      translation:
        "Experts clearly state that the policies have destroyed the economy and placed the country on the brink of deep ruin.",
    },
    observations: [
      "Unnamed expert appeal: ماہرین کا کہنا (experts say) — no identifiable sources given.",
      "Catastrophic framing: تباہ کر دیا (destroyed), گہرے تباہی کی دہلیز (brink of deep ruin).",
      "Sweeping scope claim: implied national consensus of disaster without evidence.",
    ],
  },
];

interface Question {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
}

const COMPREHENSION_QUESTIONS: Question[] = [
  {
    id: "q1",
    prompt:
      "You are annotating an Urdu news excerpt. The text uses the loaded phrase عوام دشمن فیصلہ (anti-people decision) without attributing it to any source. What should you do?",
    options: [
      "Ignore the wording and rate based only on whether you personally agree with the decision.",
      "Count the loaded, unattributed wording as part of the text's manipulative framing.",
      "Translate the phrase literally into English and treat it as a neutral fact-report.",
      "Skip the article and request a replacement, because articles with Urdu phrases are invalid.",
    ],
    correctIndex: 1,
  },
  {
    id: "q2",
    prompt:
      "Which statement best describes the minimum reading time requirement (10 s) and the one-way (no-go-back) flow?",
    options: [
      "They are arbitrary technical limitations that will be removed in the next release.",
      "Each decision is final and the timer encourages careful reading; you cannot return to a submitted article.",
      "The timer is a visual decoration and you may submit immediately if you are a fast reader.",
      "You may go back and change earlier ratings as long as you have not logged out.",
    ],
    correctIndex: 1,
  },
];

interface Cue {
  num: string;
  title: string;
  urdu: string;
  note: string;
}

const MANIPULATION_CUES: Cue[] = [
  {
    num: "1",
    title: "Sensational / emotional language",
    urdu: "ملک میں قیامت برپا، شہری خوف و غصے سے پھٹ پڑے!",
    note: "Dramatic wording and intense emotion are presented as widespread fact. Check whether the reaction is sourced.",
  },
  {
    num: "2",
    title: "One-sided or loaded wording",
    urdu: "حکومت نے عوام دشمن فیصلہ نافذ کر دیا۔",
    note: "عوام دشمن (anti-people) is a judgment. Ask whether other perspectives are shown or the wording is attributed to a source.",
  },
  {
    num: "3",
    title: "Exaggeration / clickbait-style framing",
    urdu: "آپ یقین نہیں کریں گے! ایک فیصلے نے سب کچھ بدل دیا!",
    note: "The sweeping everything-changed claim and teaser phrasing promise more than the wording establishes.",
  },
  {
    num: "4",
    title: "Missing or selective context",
    urdu: "خبر میں صرف سڑک بند ہونے کا ذکر ہے؛ احتجاج کی وجہ اور متعلقہ فریقوں کا مؤقف شامل نہیں۔",
    note: "Hypothetical note: check whether relevant background or other parties' responses are omitted.",
  },
  {
    num: "5",
    title: "Unsupported / weakly-supported claim",
    urdu: "ماہرین کے مطابق، یہ منصوبہ شہر کے تمام مسائل حل کر دے گا۔",
    note: "Experts are unnamed and the claim is absolute. Look for identifiable sources and supporting evidence.",
  },
  {
    num: "6",
    title: "Other",
    urdu: "اگر کوئی اور اندازِ پیشکش آپ کے فیصلے پر اثر انداز ہو تو اسے مختصراً بیان کریں۔",
    note: "If you notice another relevant technique, briefly describe it in your own words.",
  },
];

type CalibrationSelection = Record<string, "A" | "B" | null>;
type QSelection = Record<string, number | null>;

export default function ConsentGate() {
  const navigate = useNavigate();
  const session = JSON.parse(localStorage.getItem("nexus_user_session") || "{}");
  const userEmail = (session.email || "").toLowerCase().trim();

  const [agreeChecked, setAgreeChecked] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationSelection>({
    A: null,
    B: null,
  });
  const [answers, setAnswers] = useState<QSelection>({
    q1: null,
    q2: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState<null | string>(null);

  const calibrationScore = useMemo(() => {
    let score = 0;
    for (const pair of CALIBRATION_PAIRS) {
      if (calibration[pair.id] === pair.expectedHigh) score++;
    }
    return score;
  }, [calibration]);

  const comprehensionScore = useMemo(() => {
    let score = 0;
    for (const q of COMPREHENSION_QUESTIONS) {
      if (answers[q.id] === q.correctIndex) score++;
    }
    return score;
  }, [answers]);

  const allCalibrationDone = CALIBRATION_PAIRS.every((p) => calibration[p.id] != null);
  const allQDone = COMPREHENSION_QUESTIONS.every((q) => answers[q.id] != null);
  const canSubmit =
    agreeChecked &&
    allCalibrationDone &&
    allQDone &&
    calibrationScore >= 1 &&
    comprehensionScore >= 1 &&
    !!userEmail;

  const handleSubmit = async () => {
    if (!canSubmit) {
      if (calibrationScore < 1 || comprehensionScore < 1) {
        setShowHint(
          "You need at least 1 of 2 calibration examples correct and at least 1 of 2 comprehension questions correct before real articles are assigned. Review the scale and guidance above, then try again."
        );
      }
      return;
    }
    setShowHint(null);
    setError(null);
    setSubmitting(true);

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          email: userEmail,
          accepted: true,
          at: Date.now(),
          calibration: calibrationScore,
          comprehension: comprehensionScore,
        })
      );
      navigate("/welcome");
    } catch (e: any) {
      console.error("[ConsentGate] Save failed:", e);
      setError(
        `Could not record your consent (${String(e?.message || e).slice(0, 80)}). Please refresh and try again.`
      );
      setSubmitting(false);
    }
  };

  const logout = () => {
    localStorage.removeItem("nexus_user_session");
    window.location.href = "/";
  };

  const calibrateSelect = (pairId: "A" | "B", choice: "A" | "B") => {
    setCalibration((prev) => ({ ...prev, [pairId]: choice }));
  };

  const questionSelect = (qid: string, idx: number) => {
    setAnswers((prev) => ({ ...prev, [qid]: idx }));
  };

  return (
    <div
      style={{
        margin: 0,
        background: "var(--bg, #f6f8fc)",
        color: "var(--ink, #122449)",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: 15,
        lineHeight: 1.55,
      }}
    >
      <style>{`
        .cg-topbar{height:74px;background:#fff;border-bottom:1px solid #dce5f1;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4.5vw,66px);gap:18px}
        .cg-brand{display:flex;align-items:center;gap:14px;min-width:0}
        .cg-logo{width:40px;height:40px;border:2px solid #225bd8;border-radius:13px;color:#225bd8;display:grid;place-items:center;font-weight:850;font-size:18px}
        .cg-brandname{font-weight:850;font-size:21px;letter-spacing:-.04em;color:#122449}
        .cg-branddesc{border-left:1px solid #dce5f1;padding-left:14px;color:#586b89;font-size:11px;line-height:1.35;max-width:255px}
        .cg-righthead{text-align:right;color:#586b89;font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
        .cg-main{width:min(1160px,calc(100% - 36px));margin:31px auto 52px}
        .cg-hero{text-align:center;margin:0 auto 23px;max-width:820px}
        .cg-tag{display:inline-flex;align-items:center;gap:7px;border:1px solid #d7e4ff;background:#f0f5ff;color:#2854b5;border-radius:30px;padding:6px 13px;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
        .cg-hero h1{font-size:clamp(28px,4vw,39px);letter-spacing:-.045em;line-height:1.12;margin:13px 0 9px;color:#122449}
        .cg-hero p{margin:0 auto;color:#586b89;font-size:14px;max-width:760px}
        .cg-protocol{margin-top:11px;font-size:11px;color:#7786a0}
        .cg-grid{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);gap:16px;align-items:start}
        .cg-panel{background:#fff;border:1px solid #dce5f1;border-radius:15px;padding:20px 21px;box-shadow:0 8px 24px #18345c0b}
        .cg-panel h2{font-size:17px;line-height:1.3;margin:0 0 12px;letter-spacing:-.02em;color:#122449}
        .cg-panel h3{font-size:13px;margin:0 0 3px;color:#122449}
        .cg-section{display:grid;grid-template-columns:28px 1fr;gap:10px;margin:0 0 17px}
        .cg-section:last-child{margin-bottom:0}
        .cg-icon{width:27px;height:27px;border-radius:9px;display:grid;place-items:center;background:#eef4ff;color:#225bd8;font-size:13px;font-weight:850}
        .cg-section p,.cg-section ul{margin:3px 0 0;color:#586b89;font-size:12px}
        .cg-section ul{padding-left:17px}
        .cg-section li{margin:3px 0}
        .cg-divider{height:1px;background:#edf1f7;margin:15px 0}
        .cg-aside{background:linear-gradient(145deg,#f2f7ff,#f9fbff);border-color:#d8e5f8}
        .cg-guide-intro{color:#586b89;font-size:12px;margin:-4px 0 13px}
        .cg-cues{display:grid;gap:8px}
        .cg-cue{background:#fff;border:1px solid #e2eaf6;border-radius:11px;padding:10px 12px;display:grid;grid-template-columns:27px 1fr;gap:9px}
        .cg-cue-num{width:24px;height:24px;border-radius:8px;background:#edf3ff;color:#2358ca;display:grid;place-items:center;font-size:11px;font-weight:850}
        .cg-cue-title{font-size:12px;font-weight:800;margin-bottom:3px;color:#122449}
        .cg-urdu{direction:rtl;text-align:right;font-family:"Noto Nastaliq Urdu","Noto Naskh Arabic","Segoe UI",serif;font-size:17px;line-height:1.85;margin:2px 0 0;color:#17294b}
        .cg-cue-note{font-size:11px;color:#697994;margin:2px 0 0;line-height:1.45}
        .cg-tip{border-left:3px solid #8faeff;padding:9px 11px;background:#fff;border-radius:0 9px 9px 0;font-size:11px;color:#536783;margin-top:11px}
        .cg-calibration,.cg-scale,.cg-quiz,.cg-consent{grid-column:1/-1}
        .cg-cal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:15px}
        .cg-cal-head p{font-size:12px;color:#586b89;margin:-6px 0 12px}
        .cg-training{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#805716;background:#fff8e8;border:1px solid #f1dfba;border-radius:20px;padding:5px 9px;white-space:nowrap}
        .cg-pair{display:grid;grid-template-columns:1fr 1fr;gap:11px}
        .cg-example{border:1px solid #dce5f1;border-radius:11px;padding:12px 14px;background:#fbfcff;cursor:pointer;transition:all .15s ease}
        .cg-example:hover{border-color:#b8cdf5}
        .cg-example-selected{border:2px solid #225bd8;background:#eef4ff;padding:11px 13px}
        .cg-example-high{background:#fffaf0;border-color:#efdcae}
        .cg-example-high.cg-example-selected{border-color:#9b6410;background:#fff1d1}
        .cg-badge{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.07em;color:#4e6589;margin-bottom:4px}
        .cg-high-badge{color:#87570f}
        .cg-score{border-radius:20px;background:#eaf0f8;padding:2px 7px;color:#516683}
        .cg-high-score{background:#ffedc3;color:#81520c}
        .cg-example .cg-urdu{font-size:18px}
        .cg-translation{font-size:11px;color:#586b89;margin:5px 0 0}
        .cg-observations{margin:12px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
        .cg-observations li{font-size:10px;color:#586a86;background:#f7f9fc;border-radius:8px;padding:8px 9px}
        .cg-observations strong{color:#293e64}
        .cg-scalegrid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
        .cg-scaleitem{border:1px solid #dce5f1;border-radius:10px;padding:10px 12px;background:#fbfcff}
        .cg-scaleitem strong{display:block;font-size:12px;margin-bottom:2px}
        .cg-scaleitem span{color:#586b89;font-size:11px}
        .cg-scalezero{color:#26714d}
        .cg-scaleone{color:#966213}
        .cg-scaletwo{color:#a24141}
        .cg-quiz-section{display:grid;gap:12px}
        .cg-quiz-q{background:#fafcff;border:1px solid #e2eaf6;border-radius:11px;padding:14px 15px}
        .cg-quiz-q p{font-size:12px;font-weight:700;color:#122449;margin:0 0 9px}
        .cg-quiz-options{display:grid;gap:7px}
        .cg-quiz-opt{display:flex;align-items:flex-start;gap:10px;background:#fff;border:1px solid #dce5f1;border-radius:9px;padding:10px 12px;cursor:pointer;font-size:12px;color:#2a3c5c;font-weight:500;transition:all .12s}
        .cg-quiz-opt:hover{border-color:#b8cdf5}
        .cg-quiz-opt-sel{border-color:#225bd8;background:#eef4ff}
        .cg-quiz-opt input{accent-color:#225bd8;width:16px;height:16px;margin:2px 0 0;flex:none}
        .cg-progress{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;justify-content:space-between;align-items:center}
        .cg-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 11px;font-size:11px;font-weight:800;letter-spacing:.04em}
        .cg-chip-ok{background:#effaf3;border:1px solid #d2ecd9;color:#1d714c}
        .cg-chip-warn{background:#fff8e8;border:1px solid #f1dfba;color:#805716}
        .cg-chip-bad{background:#ffecec;border:1px solid #f0c3c3;color:#a24141}
        .cg-consent{padding:18px 21px}
        .cg-consent h2{margin-bottom:4px}
        .cg-consent p{font-size:11px;color:#586b89;margin:0 0 12px}
        .cg-checkline{display:flex;align-items:flex-start;gap:11px;border:1px solid #dce5f1;background:#fafcff;border-radius:10px;padding:12px;cursor:pointer}
        .cg-checkline input{accent-color:#225bd8;width:18px;height:18px;margin:2px 0 0;flex:none}
        .cg-checkline span{font-size:12px;font-weight:650;color:#122449}
        .cg-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:13px;flex-wrap:wrap}
        .cg-eta{font-size:10px;color:#75849b}
        .cg-button{border:0;border-radius:9px;padding:11px 17px;color:#fff;background:#225bd8;font-weight:800;font-size:12px;box-shadow:0 5px 14px #225bd82b;cursor:pointer;transition:all .15s}
        .cg-button:hover:not(:disabled){background:#1a4fc1}
        .cg-button:disabled{background:#aebbd6;box-shadow:none;cursor:not-allowed}
        .cg-button-outline{background:#fff;color:#46577a;border:1px solid #dce5f1;box-shadow:none}
        .cg-button-outline:hover:not(:disabled){background:#f4f7fc;border-color:#c3d1e7}
        .cg-hint{margin-top:11px;color:#805716;background:#fff8e8;border:1px solid #f1dfba;border-radius:9px;padding:9px 11px;font-size:11px}
        .cg-error{margin-top:11px;color:#a24141;background:#ffecec;border:1px solid #f0c3c3;border-radius:9px;padding:9px 11px;font-size:11px}
        .cg-contact{border-top:1px solid #edf1f7;margin-top:12px;padding-top:9px!important;font-size:10px!important}
        .cg-foot{text-align:center;color:#8491a4;font-size:10px;margin-top:17px}
        @media(max-width:760px){
          .cg-grid{grid-template-columns:1fr}
          .cg-calibration,.cg-scale,.cg-quiz,.cg-consent{grid-column:auto}
          .cg-topbar{height:auto;min-height:68px;padding:10px 16px}
          .cg-branddesc{max-width:160px;font-size:10px}
          .cg-righthead{font-size:8px;white-space:normal}
          .cg-pair{grid-template-columns:1fr}
          .cg-observations{grid-template-columns:1fr}
          .cg-scalegrid{grid-template-columns:1fr}
          .cg-hero{margin-bottom:18px}
          .cg-main{margin-top:23px}
        }
        @media(max-width:440px){
          .cg-brandname{font-size:18px}
          .cg-branddesc{display:none}
          .cg-topbar{align-items:flex-start}
          .cg-righthead{max-width:115px}
          .cg-cal-head{display:block}
          .cg-training{display:inline-block;margin:0 0 8px}
        }
      `}</style>

      <header className="cg-topbar">
        <div className="cg-brand">
          <div className="cg-logo" aria-hidden="true">
            N
          </div>
          <div className="cg-brandname">NEXUS</div>
          <div className="cg-branddesc">
            Hybrid NLP Framework for Detecting Media Bias and Manipulation in Urdu News
          </div>
        </div>
        <div className="cg-righthead">
          Research study &nbsp; | &nbsp; Annotation platform
        </div>
      </header>

      <main className="cg-main">
        <section className="cg-hero">
          <span className="cg-tag">▣ &nbsp;Informed consent &amp; annotation guidance</span>
          <h1>Participant Information &amp; Consent</h1>
          <p>
            Before you begin annotating, please read this information. It explains the study, what
            you will be asked to do, and how your responses will be used.
          </p>
          <div className="cg-protocol">
            COMSATS University Islamabad, Lahore Campus · Department of Computer Science · Protocol
            reference: <strong>NEXUS-ANN-P1</strong>
          </div>
        </section>

        <div className="cg-grid">
          {/* ───────── LEFT COLUMN: STUDY INFO ───────── */}
          <section className="cg-panel">
            <div className="cg-section">
              <span className="cg-icon">i</span>
              <div>
                <h3>Purpose of this study</h3>
                <p>
                  This annotation task supports NEXUS, a research project studying how manipulative
                  framing appears in Urdu-language news, blogs, and opinion writing. Your judgments,
                  alongside those of other annotators, will help build the ground truth used to train
                  and evaluate a bias-detection model.
                </p>
              </div>
            </div>
            <div className="cg-divider" />
            <div className="cg-section">
              <span className="cg-icon">✓</span>
              <div>
                <h3>What participation involves</h3>
                <ul>
                  <li>
                    Read 20 short Urdu news excerpts and independently rate their tone and writing
                    style.
                  </li>
                  <li>
                    Source and author names are withheld so you can judge the text itself.
                  </li>
                  <li>
                    After submitting a rating, you cannot return to that excerpt; each decision is
                    final.
                  </li>
                  <li>
                    A short minimum reading time is required before each submission to support
                    careful reading.
                  </li>
                  <li>
                    Estimated time: 8–10 minutes for the initial batch of 20.
                  </li>
                  <li>
                    A short calibration check below verifies you can identify manipulative framing
                    before real articles are assigned.
                  </li>
                </ul>
              </div>
            </div>
            <div className="cg-divider" />
            <div className="cg-section">
              <span className="cg-icon">⌑</span>
              <div>
                <h3>Confidentiality &amp; data use</h3>
                <p>
                  Your identity will not be attached to individual ratings shown to other annotators
                  or used in published outputs. It is retained internally to calculate annotator
                  agreement, screen for attentive reading, and contact you if an excerpt needs a
                  second look. Your annotations will be used for research purposes and may be shared
                  as part of a de-identified public dataset to aid reproducible NLP research.
                </p>
              </div>
            </div>
            <div className="cg-divider" />
            <div className="cg-section">
              <span className="cg-icon">↗</span>
              <div>
                <h3>Voluntary participation</h3>
                <p>
                  Taking part is voluntary. You may stop at any point without giving a reason, and
                  there is no penalty. Ratings already submitted remain in the dataset unless you
                  ask the research team otherwise via the contact below.
                </p>
              </div>
            </div>
          </section>

          {/* ───────── RIGHT COLUMN: MANIPULATION CUES ───────── */}
          <section className="cg-panel cg-aside">
            <h2>How to recognize possible manipulation</h2>
            <p className="cg-guide-intro">
              Look for choices in wording, evidence, and context. Each Urdu line below is a
              fictional training example — not a line from the live dataset.
            </p>
            <div className="cg-cues">
              {MANIPULATION_CUES.map((c) => (
                <article className="cg-cue" key={c.num}>
                  <span className="cg-cue-num">{c.num}</span>
                  <div>
                    <div className="cg-cue-title">{c.title}</div>
                    <p className="cg-urdu" lang="ur">
                      {c.urdu}
                    </p>
                    <p className="cg-cue-note">{c.note}</p>
                  </div>
                </article>
              ))}
            </div>
            <div className="cg-tip">
              <strong>Important:</strong> A cue alone does not prove manipulation. Consider the full
              excerpt, attribution, evidence, and context. Rate <em>what the text does</em> — not
              whether you agree with its position.
            </div>
          </section>

          {/* ───────── CALIBRATION PAIRED EXAMPLES (ATTENTION GATE) ───────── */}
          <section className="cg-panel cg-calibration">
            <div className="cg-cal-head">
              <div>
                <h2>Calibration: identify the manipulative framing (attention check)</h2>
                <p>
                  For each pair below, click the version that is <em>more</em> manipulative. Both
                  pairs are written for training and are <strong>not</strong> drawn from the live
                  dataset. You must identify correctly at least 1 of 2 before real articles are
                  assigned.
                </p>
              </div>
              <span className="cg-training">Illustrative only</span>
            </div>

            {CALIBRATION_PAIRS.map((pair, pairIdx) => (
              <div key={pair.id} style={{ marginBottom: pairIdx < CALIBRATION_PAIRS.length - 1 ? "18px" : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#46577a", letterSpacing: ".06em", marginBottom: 7 }}>
                  PAIR {pair.id} &nbsp;·&nbsp; Click the <em>more manipulative</em> version
                </div>
                <div className="cg-pair">
                  {(["A", "B"] as const).map((letter) => {
                    const item = letter === "A" ? pair.neutral : pair.high;
                    const isHigh = letter === "B";
                    const sel = calibration[pair.id] === letter;
                    return (
                      <div
                        key={letter}
                        onClick={() => calibrateSelect(pair.id, letter)}
                        className={
                          "cg-example " +
                          (sel ? "cg-example-selected " : "") +
                          (isHigh ? "cg-example-high " : "")
                        }
                      >
                        <div
                          className={
                            "cg-badge " + (isHigh ? "cg-high-badge " : "") + " "
                          }
                        >
                          <span
                            className={
                              "cg-score " + (isHigh ? "cg-high-score " : "")
                            }
                          >
                            {letter}
                          </span>
                          &nbsp;{letter === "A" ? "Version A" : "Version B"}
                          {sel && isHigh && " · candidate"}
                          {sel && !isHigh && " · candidate"}
                        </div>
                        <p className="cg-urdu" lang="ur">
                          {item.urdu}
                        </p>
                        <p className="cg-translation">{item.translation}</p>
                      </div>
                    );
                  })}
                </div>
                {calibration[pair.id] === pair.expectedHigh && (
                  <ul className="cg-observations">
                    {pair.observations.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </section>

          {/* ───────── SCALE DESCRIPTION ───────── */}
          <section className="cg-panel cg-scale">
            <h2>Rating scale you will use for each article</h2>
            <div className="cg-scalegrid">
              <div className="cg-scaleitem">
                <strong className="cg-scalezero">0 · Neutral</strong>
                <span>Reports facts without notable loaded language or one-sided framing.</span>
              </div>
              <div className="cg-scaleitem">
                <strong className="cg-scaleone">1 · Slightly manipulative</strong>
                <span>Mostly factual, with occasional wording or framing that leans one way.</span>
              </div>
              <div className="cg-scaleitem">
                <strong className="cg-scaletwo">2 · Highly manipulative</strong>
                <span>Consistent loaded language, weakly-supported claims, or one-sided framing.</span>
              </div>
            </div>
          </section>

          {/* ───────── COMPREHENSION / MANIPULATION-DETECTION QUIZ ───────── */}
          <section className="cg-panel cg-quiz">
            <h2>Quick comprehension check</h2>
            <p style={{ fontSize: 12, color: "#586b89", margin: "-6px 0 12px" }}>
              Answer both questions. At least 1 of 2 must be correct before real articles are
              assigned to you. This helps ensure attentive and consistent ratings across the study.
            </p>
            <div className="cg-quiz-section">
              {COMPREHENSION_QUESTIONS.map((q) => (
                <div className="cg-quiz-q" key={q.id}>
                  <p>{q.prompt}</p>
                  <div className="cg-quiz-options">
                    {q.options.map((opt, idx) => {
                      const sel = answers[q.id] === idx;
                      return (
                        <label
                          key={idx}
                          className={"cg-quiz-opt " + (sel ? "cg-quiz-opt-sel" : "")}
                        >
                          <input
                            type="radio"
                            name={q.id}
                            checked={sel}
                            onChange={() => questionSelect(q.id, idx)}
                          />
                          <span>{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="cg-progress">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span
                  className={
                    "cg-chip " +
                    (calibrationScore >= 2
                      ? "cg-chip-ok"
                      : calibrationScore >= 1
                      ? "cg-chip-warn"
                      : "cg-chip-bad")
                  }
                >
                  Calibration: {calibrationScore} / {CALIBRATION_PAIRS.length}
                  {"  "}
                  {calibrationScore >= 1 ? "✓ passed" : "below threshold"}
                </span>
                <span
                  className={
                    "cg-chip " +
                    (comprehensionScore >= 2
                      ? "cg-chip-ok"
                      : comprehensionScore >= 1
                      ? "cg-chip-warn"
                      : "cg-chip-bad")
                  }
                >
                  Comprehension: {comprehensionScore} / {COMPREHENSION_QUESTIONS.length}
                  {"  "}
                  {comprehensionScore >= 1 ? "✓ passed" : "below threshold"}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "#75849b", whiteSpace: "nowrap" }}>
                Minimum: &nbsp;≥ 1 calibration correct &nbsp;and&nbsp; ≥ 1 comprehension correct
              </div>
            </div>
          </section>

          {/* ───────── CONSENT CHECKBOX + SUBMIT ───────── */}
          <section className="cg-panel cg-consent">
            <h2>Your consent</h2>
            <p>
              Please confirm that you have read and understood the information above. You may stop
              participating at any point without penalty. Your consent, calibration score, and
              comprehension score are stored with your annotator document (see Confidentiality
              above).
            </p>
            <label
              className="cg-checkline"
              onClick={() => setAgreeChecked((v) => !v)}
            >
              <input
                type="checkbox"
                checked={agreeChecked}
                onChange={(e) => setAgreeChecked(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span>
                I have read and understood the information above. I voluntarily agree to take part
                in the NEXUS annotation study, understanding that I may withdraw at any time. I
                confirm that I can identify and rate the manipulative framing cues described on
                this page.
              </span>
            </label>

            {showHint && <div className="cg-hint">{showHint}</div>}
            {error && <div className="cg-error">{error}</div>}

            <div className="cg-actions">
              <span className="cg-eta">
                Estimated time: 8–10 minutes &nbsp;·&nbsp; 20 excerpts per batch
              </span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="cg-button cg-button-outline"
                  onClick={logout}
                  disabled={submitting}
                  type="button"
                >
                  Cancel / Logout
                </button>
                <button
                  className="cg-button"
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                  type="button"
                >
                  {submitting ? "Recording consent…" : "Accept, confirm & begin →"}
                </button>
              </div>
            </div>

            <p className="cg-contact">
              Questions about this study: Supervising researcher, Department of Computer Science,
              COMSATS University Islamabad, Lahore Campus. Please contact the research
              administrator for approved researcher contact details.
            </p>
          </section>
        </div>

        <footer className="cg-foot">
          NEXUS Research Study · Participant information, consent and calibration
        </footer>
      </main>
    </div>
  );
}

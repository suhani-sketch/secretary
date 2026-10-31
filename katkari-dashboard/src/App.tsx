import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HOUSEHOLDS, welfareScore, type HH } from "./data";
import "./App.css";

type View = "board" | "cases";

const N = HOUSEHOLDS.length;
const PIE_COLORS = ["#3b82f6", "#f59e0b", "#64748b", "#10b981"];

function count(pred: (h: HH) => boolean) {
  return HOUSEHOLDS.filter(pred).length;
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "danger" | "warning" | "info";
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone ?? ""}`}>{value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  );
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.round((value / max) * 100);
  const tone = pct < 25 ? "low" : pct < 50 ? "mid" : "ok";
  return (
    <div className="score-bar">
      <div className="score-bar-head">
        <span>{label}</span>
        <span>
          {value}/{max}
        </span>
      </div>
      <div className="score-track">
        <div className={`score-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Board() {
  const withCard = count((h) => h.card === "Yes");
  const zeroDays = count((h) => h.days === 0);
  const notAware = count((h) => h.barrier === "Not aware");
  const shgYes = count((h) => h.shg === "Yes");
  const skillYes = count((h) => h.skill === "Yes");
  const farmYes = count((h) => h.farm === "Yes");
  const kutcha = count((h) => h.house === "Kutcha");
  const needsUnmet = count((h) => h.needs === "Not at all");

  const workBuckets = useMemo(() => {
    const buckets: Record<string, number> = {};
    for (const h of HOUSEHOLDS) {
      const key = h.work.includes("Agri")
        ? "Agri wage"
        : h.work.includes("Land") || h.work.includes("plot")
          ? "Land / small plot"
          : h.work.includes("Brick") || h.work.includes("Construction") || h.work.includes("Sand")
            ? "Non-farm wage"
            : "Forest / mixed";
      buckets[key] = (buckets[key] || 0) + 1;
    }
    return Object.entries(buckets).map(([name, value]) => ({ name, value }));
  }, []);

  const barrierBuckets = useMemo(() => {
    const buckets: Record<string, number> = {};
    for (const h of HOUSEHOLDS) {
      buckets[h.barrier] = (buckets[h.barrier] || 0) + 1;
    }
    return Object.entries(buckets).map(([name, value]) => ({ name, value }));
  }, []);

  const padaBuckets = useMemo(() => {
    const buckets: Record<string, number> = {};
    for (const h of HOUSEHOLDS) {
      buckets[h.pada] = (buckets[h.pada] || 0) + 1;
    }
    return Object.entries(buckets).map(([name, value]) => ({ name, value }));
  }, []);

  const schemeReach = [
    { label: "Job card", yes: withCard, no: N - withCard },
    { label: "Any MGNREGA days", yes: N - zeroDays, no: zeroDays },
    { label: "Farm scheme", yes: farmYes, no: N - farmYes },
    { label: "SHG member", yes: shgYes, no: N - shgYes },
    { label: "Skill trained", yes: skillYes, no: N - skillYes },
  ];

  const scores = HOUSEHOLDS.map((h) => ({ id: h.id, score: welfareScore(h) }));
  const avgScore = (scores.reduce((a, b) => a + b.score, 0) / N).toFixed(1);
  const daysData = HOUSEHOLDS.map((h) => ({ id: h.id, days: h.days }));

  return (
    <div className="stack">
      <section className="card">
        <div className="card-h">What the literature already says</div>
        <div className="card-b">
          <div className="grid-4">
            <Metric label="Status" value="PVTG" detail="Maharashtra (PIB / MoTA)" tone="info" />
            <Metric label="Literacy" value="41.7%" detail="Lowest among STs (EPW 2017)" tone="warning" />
            <Metric label="Cultivators" value="~5%" detail="Lowest ST share (EPW 2017)" tone="danger" />
            <Metric label="Field sites" value="5 padas" detail="Ambernath, Badlapur" />
          </div>
          <p className="muted">
            Thane–Raigad studies describe Katkari households as mostly landless, living on wage work, moving for kiln and construction jobs, and getting little from MGNREGA. Caste certificates are often missing. I used that as background for reading my schedules.
          </p>
        </div>
      </section>

      <h2 className="section">1. Observations</h2>

      <div className="grid-6">
        <Metric label="Households" value={String(N)} detail="Schedules coded" />
        <Metric
          label="Job cards"
          value={`${withCard}/${N}`}
          detail={`${Math.round((withCard / N) * 100)}% have one`}
          tone={withCard < N / 2 ? "danger" : "warning"}
        />
        <Metric label="Zero days" value={`${zeroDays}/${N}`} detail="No MGNREGA work" tone="danger" />
        <Metric label="Not aware" value={`${notAware}/${N}`} detail="Said this as the barrier" tone="warning" />
        <Metric label="Avg access" value={avgScore} detail="Out of 8" tone="info" />
        <Metric label="Kutcha house" value={`${kutcha}/${N}`} detail="Housing" tone="warning" />
      </div>

      <div className="grid-3">
        <section className="card">
          <div className="card-h">
            Who gets schemes <span className="pill">n={N}</span>
          </div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={schemeReach}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="yes" name="Yes" stackId="a" fill="#22c55e" />
                <Bar dataKey="no" name="No" stackId="a" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <div className="card-h">What work looks like</div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={workBuckets} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75}>
                  {workBuckets.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <p className="muted small">Mostly agri wage. Some kiln, quarry, construction. A few with land.</p>
          </div>
        </section>

        <section className="card">
          <div className="card-h">Barriers people named</div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={barrierBuckets} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="value" name="Households" fill="#f59e0b" label={{ position: "right", fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-h">MGNREGA days</div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={daysData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="id" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="days" name="Days" fill="#3b82f6" label={{ position: "top", fontSize: 10 }} />
              </BarChart>
            </ResponsiveContainer>
            <p className="muted small">Six at zero. The rest only 12–40 days.</p>
          </div>
        </section>

        <section className="card">
          <div className="card-h">Access score (0–8)</div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={scores}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="id" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 8]} allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="score" name="Score" fill="#6366f1" label={{ position: "top", fontSize: 10 }} />
              </BarChart>
            </ResponsiveContainer>
            <div className="score-list">
              <ScoreBar label="Average" value={Number(avgScore)} max={8} />
              <ScoreBar label="Needs unmet" value={needsUnmet} max={N} />
              <ScoreBar label="In an SHG" value={shgYes} max={N} />
            </div>
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-h">By pada</div>
          <div className="card-b chart-box">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={padaBuckets}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="value" name="HH" fill="#0ea5e9" label={{ position: "top", fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <div className="card-h">House and water</div>
          <div className="card-b">
            <div className="grid-2 tight">
              {[
                ["Kutcha", `${kutcha}`],
                ["Semi-pucca", `${N - kutcha}`],
                ["Never applied PMAY", `${count((h) => h.pmay === "Never applied")}`],
                [
                  "River / stream water",
                  `${count(
                    (h) =>
                      h.water.toLowerCase().includes("river") ||
                      h.water.toLowerCase().includes("stream"),
                  )}`,
                ],
                ["In an SHG", `${shgYes}`],
                ["Any skill training", `${skillYes}`],
              ].map(([k, v]) => (
                <div key={k} className="tile">
                  <div className="muted small">{k}</div>
                  <div className="tile-v">{v}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-h">Household list</div>
        <div className="card-b table-wrap">
          <table>
            <thead>
              <tr>
                {["ID", "Pada", "Work", "Wage", "Card", "Days", "SHG", "Barrier", "Score"].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HOUSEHOLDS.map((h) => (
                <tr key={h.id}>
                  <td>{h.id}</td>
                  <td>{h.pada}</td>
                  <td>{h.work}</td>
                  <td>{h.wage}</td>
                  <td>{h.card}</td>
                  <td>{h.days}</td>
                  <td>{h.shg}</td>
                  <td>{h.barrier}</td>
                  <td>{welfareScore(h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="callout">
        <strong>In short</strong>
        <p>
          People are working. Most still have no real hold on MGNREGA, farm schemes, SHGs or training. The answer I heard again and again was “not aware.” Even where someone had land or a card, the other supports usually were not there.
        </p>
      </div>

      <h2 className="section">2. What I learnt</h2>
      <div className="grid-3">
        <section className="card">
          <div className="card-h">On participation</div>
          <div className="card-b">
            <p>
              If people cannot get onto schemes, they are not really in the system. Being quiet and grateful is not the same as having a say.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="card-h">On welfare</div>
          <div className="card-b">
            <p>
              Giving land or a job card is not enough on its own. Without help with papers, work demand, SHG and training where people live, not much changes at home.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="card-h">On fieldwork</div>
          <div className="card-b">
            <p>
              When someone says “not aware,” that is data. Ten households show a pattern, not the whole picture.
            </p>
          </div>
        </section>
      </div>

      <h2 className="section">3. One change I would make</h2>
      <section className="card">
        <div className="card-h">A 2–3 day camp in the pada</div>
        <div className="card-b">
          <div className="grid-3">
            {[
              ["1", "MGNREGA job cards", "Get every eligible adult on a card, or fix the one they already have"],
              ["2", "E-Shram and women’s SHG", "Do both the same day, with staff who know the forms"],
              ["3", "Tailoring / crafts", "Bring a short training batch to the pada, not the other way round"],
            ].map(([n, t, d]) => (
              <div key={n} className="tile tall">
                <div className="muted small">{n}</div>
                <div className="tile-title">{t}</div>
                <div className="muted small">{d}</div>
              </div>
            ))}
          </div>
          <p className="muted">
            Offices are far and people do not know the steps. A camp in the pada deals with both. I would start with livelihoods because that is what people asked about first.
          </p>
        </div>
      </section>
    </div>
  );
}

function Cases() {
  const sorted = [...HOUSEHOLDS].sort((a, b) => welfareScore(a) - welfareScore(b));
  return (
    <div className="stack">
      <div>
        <h2 className="section" style={{ marginBottom: 4 }}>
          Household cards
        </h2>
        <p className="muted">Sorted from low access to high</p>
      </div>
      <div className="grid-2">
        {sorted.map((h) => (
          <div key={h.id} className="card pad">
            <div className="row">
              <strong>
                {h.id} · {h.pada}
              </strong>
              <span className="pill">{welfareScore(h)}/8</span>
            </div>
            <p className="muted small">
              {h.work} · earners {h.earners} · {h.wage}
            </p>
            <p className="muted small">
              Assets: {h.assets} · Needs: {h.needs} · Women: {h.women}
            </p>
            <p className="muted small">
              Card {h.card} · {h.days} days · Farm {h.farm} · SHG {h.shg} · Skill {h.skill}
            </p>
            <p>
              <strong>Barrier: {h.barrier}</strong>
            </p>
            <p className="muted small">
              Want: {h.want} · House {h.house} · Water {h.water} · PMAY {h.pmay}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("board");

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="title">Katkari livelihoods</div>
          <div className="sub">
            Field practicum, Ambernath and Badlapur, 15–17 Oct 2026 · Suhani Bhatia, TISS
          </div>
        </div>
        <div className="tabs">
          {(["board", "cases"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)} type="button">
              {v === "board" ? "Board" : "Cases"}
            </button>
          ))}
        </div>
      </header>
      <main className="main">{view === "board" ? <Board /> : <Cases />}</main>
    </div>
  );
}

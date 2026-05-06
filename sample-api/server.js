const express = require("express");

const app = express();
app.use(express.json());

const incidents = [
  {
    id: "inc-001",
    title: "Network outage in east region",
    description: "Multiple customers reporting connectivity issues",
    severity: "critical",
    status: "investigating",
    reportedBy: "ops-team",
    createdAt: "2026-05-01T08:30:00Z",
    updatedAt: "2026-05-01T09:15:00Z",
  },
  {
    id: "inc-002",
    title: "Elevated error rates on payment processing",
    description: "Timeout errors on downstream payment gateway",
    severity: "high",
    status: "open",
    reportedBy: "platform-team",
    createdAt: "2026-05-02T14:00:00Z",
    updatedAt: "2026-05-02T14:00:00Z",
  },
  {
    id: "inc-003",
    title: "Scheduled maintenance notification delay",
    description: "Customer notifications sent 2 hours late",
    severity: "medium",
    status: "resolved",
    reportedBy: "comms-team",
    createdAt: "2026-04-28T11:00:00Z",
    updatedAt: "2026-04-29T16:00:00Z",
  },
];

let nextNum = 4;

app.get("/api/incidents", (req, res) => {
  let result = incidents;
  if (req.query.severity) {
    result = result.filter((i) => i.severity === req.query.severity);
  }
  if (req.query.status) {
    result = result.filter((i) => i.status === req.query.status);
  }
  res.json(result);
});

app.post("/api/incidents", (req, res) => {
  const { title, description, severity, reportedBy } = req.body;
  if (!title || !severity) {
    return res.status(400).json({ error: "title and severity are required" });
  }
  const now = new Date().toISOString();
  const incident = {
    id: `inc-${String(nextNum++).padStart(3, "0")}`,
    title,
    description: description || "",
    severity,
    status: "open",
    reportedBy: reportedBy || "unknown",
    createdAt: now,
    updatedAt: now,
  };
  incidents.push(incident);
  res.status(201).json(incident);
});

app.get("/api/incidents/:id", (req, res) => {
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: "Incident not found" });
  res.json(incident);
});

app.patch("/api/incidents/:id", (req, res) => {
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: "Incident not found" });

  const allowed = ["title", "description", "severity", "status"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) incident[key] = req.body[key];
  }
  incident.updatedAt = new Date().toISOString();
  res.json(incident);
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Incident API listening on port ${PORT}`));

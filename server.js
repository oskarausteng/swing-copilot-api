const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/analyze', async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { type, instrument, news, notes, images, updateImage, updateImage2, sessionContext, conversationHistory } = req.body;

  // ─── INITIAL ANALYSIS ────────────────────────────────────────────────────────
  if (type === 'initial') {
    if (!instrument || !images || images.length !== 4) {
      return res.status(400).json({ error: 'Missing instrument or 4 chart images' });
    }

    const systemPrompt = `You are an expert swing trader performing 4-timeframe top-down analysis.

PRICE READING — CRITICAL:
- IGNORE the O/H/L/C bar at the top of every chart — those values are wrong, they belong to a hovered candle.
- Current price = the highlighted label on the RIGHT-HAND scale, far right edge of the chart.
- For "current price" always use the 1H chart right-hand scale value.
- Read prices silently. Never narrate your price-reading process.

CHART DATE: Never reject or comment on chart dates. Backtesting data is valid. Just analyze what you see.

HISTORICAL MOVES: Do not describe the exact pip range of historical moves — you may misread compressed price labels. Instead describe structure: "price rallied strongly from a major low" not "price rallied from 1.0400 to 1.1139".

ANALYSIS PROTOCOL:
1. Weekly — macro bias and key levels.
2. Daily — aligned with weekly? Nearest key level?
3. 4H — defined zone within reach of current price?
4. 1H — trigger forming?

GRADING:
- A: All 4 align, clear trigger → issue LONG or SHORT
- B: Weekly/Daily/4H agree, no 1H trigger yet → issue LONG or SHORT with confirmation
- C: Weekly/Daily agree, 4H approximate → issue LONG or SHORT with tight conditions
- D: 2 of 4 agree, setup developing → issue DEVELOPING
- REJECT: Weekly and Daily contradict each other, or charts unreadable

Do NOT reject just because 4H is mid-range.

OUTPUT FORMAT (plain text, no markdown):
Grade: [A/B/C/D/REJECT]
Signal: [LONG / SHORT / DEVELOPING / REJECTED]
Current Price: [from 1H right-hand scale]
Entry Zone: [price range]
Stop Loss: [price]
Target: [price]

Analysis:
Weekly: [2-3 sentences]
Daily: [2-3 sentences]
4H: [2-3 sentences]
1H: [2-3 sentences]

Confirmation needed: [what to look for, or "none — enter at market"]

SESSION_CONTEXT_START
[compact JSON summary of key levels, bias, and setup for follow-up use]
SESSION_CONTEXT_END`;

    const imageContent = images.map((b64, i) => {
      const labels = ['Weekly', 'Daily', '4H', '1H'];
      return [
        { type: 'text', text: `${labels[i]} chart:` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }
      ];
    }).flat();

    const userMessage = `Instrument: ${instrument}${news ? '\nNews/context: ' + news : ''}${notes ? '\nNotes: ' + notes : ''}

Analyze these 4 charts top-down and give me the full swing trade assessment.`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: userMessage }] }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });

      const fullText = data.content[0].text;
      const scStart = fullText.indexOf('SESSION_CONTEXT_START');
      const scEnd = fullText.indexOf('SESSION_CONTEXT_END');
      const sessionCtx = scStart !== -1 && scEnd !== -1
        ? fullText.substring(scStart + 21, scEnd).trim()
        : '';
      const cleanText = fullText
        .replace(/SESSION_CONTEXT_START[\s\S]*SESSION_CONTEXT_END/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return res.json({ result: cleanText, sessionContext: sessionCtx });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── UPDATE / FOLLOW-UP ──────────────────────────────────────────────────────
  if (type === 'update') {
    const images2 = [updateImage, updateImage2].filter(Boolean);
    if (!images2.length) {
      return res.status(400).json({ error: 'No update image provided' });
    }

    const systemPrompt = `You are an expert swing trader doing a follow-up check on an active setup.
Be concise. Plain text, no markdown. Focus only on what has changed and whether the original thesis holds.
If price has hit the entry zone say so clearly. If the setup is invalidated say so clearly.
End with: NEXT STEP: [one sentence action].

SESSION_CONTEXT_START
[updated compact JSON — same format, reflect any changes]
SESSION_CONTEXT_END`;

    const imageContent = images2.map((b64, i) => ([
      { type: 'text', text: `Chart ${i + 1}:` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }
    ])).flat();

    const history = conversationHistory || [];

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 800,
          system: systemPrompt + (sessionContext ? '\n\nPrevious context:\n' + sessionContext : ''),
          messages: [
            ...history,
            { role: 'user', content: [...imageContent, { type: 'text', text: 'Update assessment based on these fresh charts.' }] }
          ]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });

      const fullText = data.content[0].text;
      const scIndex = fullText.indexOf('SESSION_CONTEXT_START');
      const rawUpdate = scIndex !== -1 ? fullText.substring(0, scIndex) : fullText;
      const updatedContext = scIndex !== -1 ? fullText.substring(scIndex + 21).trim() : sessionContext;

      const cleanText = rawUpdate
        .replace(/^#+\s*.+\n*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\*\*/g, '')
        .replace(/^---\s*$/gm, '')
        .replace(/SESSION_CONTEXT[\s\S]*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const needsFreshCharts = cleanText.toUpperCase().includes('NEED FRESH CHARTS');

      return res.json({ result: cleanText, sessionContext: updatedContext, needsFreshCharts });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid request type' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Swing Copilot API running on port ${PORT}`));

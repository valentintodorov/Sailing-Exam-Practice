# Sailing Exam Practice

Practice trainer for the VODACH 40BT sailing exam.

Live: https://valentintodorov.github.io/Sailing-Exam-Practice/

`exam-trainer.html` is the app. On first visit it loads the questions from
`vodach-40bt-questions-embedded.json` (next to the page); progress is kept in the browser.
Older iterations are kept as `exam-trainer-v1/v2/v3.html`.

## Run locally

```
node .claude/serve.js
```

Then open http://localhost:8765. (Opening the file directly from disk works too, but then the
questions must be imported by hand, since browsers block auto-loading from `file://`.)

## Tests

Requires Node.js, no dependencies:

```
node tests/trainer.test.js
```

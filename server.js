const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ LOAD QUESTIONS ============
function loadAllQuestions() {
  const mainFile = path.join(__dirname, 'data', 'questions.json');
  const mainData = JSON.parse(fs.readFileSync(mainFile, 'utf8'));
  const dataDir = path.join(__dirname, 'data');
  const batchFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('questions-batch') && f.endsWith('.json'));
  batchFiles.forEach(file => {
    try {
      const batch = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      if (Array.isArray(batch)) mainData.questions.push(...batch);
    } catch (e) { console.log(`Warning: ${file}: ${e.message}`); }
  });
  const seen = new Set();
  mainData.questions = mainData.questions.filter(q => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });
  console.log(`Loaded ${mainData.questions.length} questions`);
  return mainData;
}
const questionsData = loadAllQuestions();

// ============ PERSISTENT DATA STORE ============
const TRACKER_FILE = path.join(__dirname, 'data', 'tracker.json');
let tracker = {
  teachers: { pin: '2024' },  // Simple PIN for teacher access
  students: {},     // { studentName: { name, scores: [{date, score, correct, total, time}] } }
  assignments: {},  // { '2026-04-13': { questions: [...ids], createdBy, createdAt } }
  leaderboard: []   // Computed from students
};

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      tracker = { ...tracker, ...JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8')) };
      console.log(`Tracker loaded: ${Object.keys(tracker.students).length} students, ${Object.keys(tracker.assignments).length} assignments`);
    }
  } catch (e) { console.log('No existing tracker, starting fresh'); }
}

function saveTracker() {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
  } catch (e) { console.log('Save tracker error:', e.message); }
}

loadTracker();

// ============ HELPER ============
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

// ============ API: CATEGORIES & QUESTIONS ============
app.get('/api/categories', (req, res) => {
  res.json(questionsData.categories.map(cat => ({
    ...cat,
    questionCount: questionsData.questions.filter(q => q.category === cat.id).length
  })));
});

app.get('/api/stats', (req, res) => {
  const total = questionsData.questions.length;
  const byCat = {}, byDiff = { easy: 0, medium: 0, hard: 0 };
  questionsData.questions.forEach(q => {
    byCat[q.category] = (byCat[q.category] || 0) + 1;
    byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  });
  res.json({ total, byCategory: byCat, byDifficulty: byDiff });
});

app.get('/api/questions/:category', (req, res) => {
  let qs = questionsData.questions.filter(q => q.category === req.params.category);
  if (req.query.difficulty && req.query.difficulty !== 'all')
    qs = qs.filter(q => q.difficulty === req.query.difficulty);
  res.json(shuffleArray(qs));
});

app.get('/api/questions/mix/random', (req, res) => {
  const count = parseInt(req.query.count) || 15;
  let qs = [...questionsData.questions];
  if (req.query.difficulty && req.query.difficulty !== 'all')
    qs = qs.filter(q => q.difficulty === req.query.difficulty);
  const shuffled = shuffleArray(qs);
  res.json(shuffled.slice(0, Math.min(count, shuffled.length)));
});

// ============ API: TEACHER ============
app.post('/api/teacher/login', (req, res) => {
  const { pin } = req.body;
  if (pin === tracker.teachers.pin) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Incorrect PIN' });
  }
});

app.post('/api/teacher/assign', (req, res) => {
  const { pin, date, questionCount, categories } = req.body;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const targetDate = date || todayStr();
  const count = questionCount || 10;

  // Pick questions — balanced across categories
  let pool = [...questionsData.questions];
  if (categories && categories !== 'all') {
    const cats = categories.split(',');
    pool = pool.filter(q => cats.includes(q.category));
  }

  // Balanced selection
  const grouped = {};
  pool.forEach(q => { if (!grouped[q.category]) grouped[q.category] = []; grouped[q.category].push(q); });
  Object.values(grouped).forEach(arr => shuffleArray(arr));

  const selected = [];
  const catKeys = Object.keys(grouped);
  let idx = 0;
  while (selected.length < count && catKeys.length > 0) {
    const key = catKeys[idx % catKeys.length];
    if (grouped[key].length > 0) {
      selected.push(grouped[key].pop());
    } else {
      catKeys.splice(catKeys.indexOf(key), 1);
      if (catKeys.length === 0) break;
    }
    idx++;
  }

  tracker.assignments[targetDate] = {
    questionIds: selected.map(q => q.id),
    createdAt: new Date().toISOString(),
    questionCount: selected.length
  };
  saveTracker();

  res.json({
    success: true,
    date: targetDate,
    questionCount: selected.length,
    message: `Assignment created for ${targetDate} with ${selected.length} questions`
  });
});

app.get('/api/teacher/assignments', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });
  res.json(tracker.assignments);
});

app.get('/api/teacher/scores', (req, res) => {
  const { pin, date } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const students = Object.values(tracker.students);

  if (date) {
    // Scores for a specific date — show all attempts
    const dayScores = students.map(s => {
      const dayAttempts = s.scores.filter(sc => sc.date === date);
      const bestAttempt = dayAttempts.length > 0
        ? dayAttempts.reduce((best, curr) => curr.score > best.score ? curr : best, dayAttempts[0])
        : null;
      return {
        name: s.name,
        completed: dayAttempts.length > 0,
        attempts: dayAttempts.map(a => ({
          attempt: a.attempt || 1,
          score: a.score,
          correct: a.correct,
          total: a.total,
          percentage: Math.round((a.correct / a.total) * 100),
          completedAt: a.completedAt
        })),
        bestScore: bestAttempt ? bestAttempt.score : 0,
        bestCorrect: bestAttempt ? bestAttempt.correct : 0,
        totalAttempts: dayAttempts.length
      };
    }).sort((a, b) => b.bestScore - a.bestScore);
    return res.json(dayScores);
  }

  // Overall scores
  const overall = students.map(s => {
    const totalCorrect = s.scores.reduce((sum, sc) => sum + sc.correct, 0);
    const totalAnswered = s.scores.reduce((sum, sc) => sum + sc.total, 0);
    const totalScore = s.scores.reduce((sum, sc) => sum + sc.score, 0);
    return {
      name: s.name,
      daysCompleted: s.scores.length,
      totalScore,
      totalCorrect,
      totalAnswered,
      accuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0,
      lastActive: s.scores.length > 0 ? s.scores[s.scores.length - 1].date : 'Never'
    };
  }).sort((a, b) => b.totalScore - a.totalScore);

  res.json(overall);
});

app.get('/api/teacher/dashboard', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const today = todayStr();
  const students = Object.values(tracker.students);
  const todayAssignment = tracker.assignments[today];

  const todayScores = students.map(s => {
    const dayAttempts = s.scores.filter(sc => sc.date === today);
    const bestAttempt = dayAttempts.length > 0
      ? dayAttempts.reduce((best, curr) => curr.score > best.score ? curr : best, dayAttempts[0])
      : null;
    return {
      name: s.name,
      completed: dayAttempts.length > 0,
      attempts: dayAttempts.map(a => ({ attempt: a.attempt || 1, score: a.score, correct: a.correct, total: a.total })),
      bestScore: bestAttempt ? bestAttempt.score : 0,
      bestCorrect: bestAttempt ? bestAttempt.correct : 0,
      bestTotal: bestAttempt ? bestAttempt.total : 0,
      totalAttempts: dayAttempts.length
    };
  });

  const completedToday = todayScores.filter(s => s.completed).length;

  // Overall leaderboard
  const leaderboard = students.map(s => {
    const totalScore = s.scores.reduce((sum, sc) => sum + sc.score, 0);
    const totalCorrect = s.scores.reduce((sum, sc) => sum + sc.correct, 0);
    const totalAnswered = s.scores.reduce((sum, sc) => sum + sc.total, 0);
    return {
      name: s.name,
      totalScore,
      daysCompleted: s.scores.length,
      accuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0
    };
  }).sort((a, b) => b.totalScore - a.totalScore);

  res.json({
    today,
    hasAssignment: !!todayAssignment,
    assignmentQuestionCount: todayAssignment?.questionCount || 0,
    totalStudents: students.length,
    completedToday,
    todayScores: todayScores.sort((a, b) => b.score - a.score),
    leaderboard,
    totalAssignments: Object.keys(tracker.assignments).length
  });
});

// ============ API: STUDENT DAILY ============
app.get('/api/daily/today', (req, res) => {
  const today = todayStr();
  const assignment = tracker.assignments[today];
  if (!assignment) {
    return res.json({ hasAssignment: false, message: 'No assignment for today yet. Check back later!' });
  }

  const questions = assignment.questionIds
    .map(id => questionsData.questions.find(q => q.id === id))
    .filter(Boolean)
    .map(q => ({
      id: q.id, category: q.category, difficulty: q.difficulty,
      question: q.question, options: q.options, reference: q.reference
      // Note: correct answer NOT sent — prevents cheating
    }));

  res.json({ hasAssignment: true, date: today, questions, questionCount: questions.length });
});

app.post('/api/daily/submit', (req, res) => {
  const { studentName, date, answers } = req.body;
  if (!studentName || !answers) return res.status(400).json({ message: 'Name and answers required' });

  const targetDate = date || todayStr();
  const assignment = tracker.assignments[targetDate];
  if (!assignment) return res.status(404).json({ message: 'No assignment for this date' });

  const name = studentName.trim();
  const nameKey = name.toLowerCase();

  // Allow up to 3 attempts per day
  if (tracker.students[nameKey]) {
    const todayAttempts = tracker.students[nameKey].scores.filter(s => s.date === targetDate);
    if (todayAttempts.length >= 3) {
      return res.status(400).json({ message: 'You\'ve used all 3 attempts for today! Practice in Free Practice mode to keep studying.' });
    }
  }

  // Grade the answers
  let correct = 0;
  let score = 0;
  const results = [];

  answers.forEach(({ questionId, answerIndex }) => {
    const q = questionsData.questions.find(qu => qu.id === questionId);
    if (!q) return;
    const isCorrect = answerIndex === q.correct;
    if (isCorrect) {
      correct++;
      score += 100;
    }
    results.push({
      questionId,
      isCorrect,
      correctAnswer: q.correct,
      explanation: q.explanation,
      reference: q.reference
    });
  });

  const total = assignment.questionIds.length;

  // Save student record
  if (!tracker.students[nameKey]) {
    tracker.students[nameKey] = { name, scores: [] };
  }
  tracker.students[nameKey].name = name;
  const todayAttempts = tracker.students[nameKey].scores.filter(s => s.date === targetDate);
  const attemptNum = todayAttempts.length + 1;
  tracker.students[nameKey].scores.push({
    date: targetDate,
    attempt: attemptNum,
    score,
    correct,
    total,
    completedAt: new Date().toISOString()
  });

  saveTracker();

  res.json({
    success: true,
    score,
    correct,
    total,
    percentage: Math.round((correct / total) * 100),
    results
  });
});

app.get('/api/daily/leaderboard', (req, res) => {
  const students = Object.values(tracker.students);
  const leaderboard = students.map(s => {
    const totalScore = s.scores.reduce((sum, sc) => sum + sc.score, 0);
    const totalCorrect = s.scores.reduce((sum, sc) => sum + sc.correct, 0);
    const totalAnswered = s.scores.reduce((sum, sc) => sum + sc.total, 0);
    return {
      name: s.name,
      totalScore,
      daysCompleted: s.scores.length,
      accuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0
    };
  }).sort((a, b) => b.totalScore - a.totalScore);
  res.json(leaderboard);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', questions: questionsData.questions.length, students: Object.keys(tracker.students).length });
});

// ============ LIVE QUIZ (Socket.io) — Individual players, teacher hosts ============
const rooms = new Map();

io.on('connection', (socket) => {

  // Teacher creates a game room
  socket.on('host-game', ({ questionCount, timePerQuestion }) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: socket.id,
      players: [],  // { id, name, score, answers[] }
      settings: { questionCount: questionCount || 10, timePerQuestion: timePerQuestion || 20 },
      state: 'waiting',
      currentQuestion: -1,
      questions: [],
      questionTimer: null,
      questionDeadline: null
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('room-created', { roomCode, players: [] });
  });

  // Kid joins with their name
  socket.on('join-game', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error-msg', { message: 'Room not found! Check the code and try again.' });
    if (room.state !== 'waiting') return socket.emit('error-msg', { message: 'Game already started! Wait for the next round.' });
    if (room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return socket.emit('error-msg', { message: `${playerName} is already in the game!` });
    }
    if (room.players.length >= 10) return socket.emit('error-msg', { message: 'Game is full!' });

    const player = { id: socket.id, name: playerName, score: 0, answers: [] };
    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('joined-game', { roomCode: code, playerName, players: room.players.map(p => p.name) });
    io.to(code).emit('players-updated', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });

  // Teacher starts the game
  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    if (room.players.length === 0) return socket.emit('error-msg', { message: 'No players have joined yet!' });

    // Pick balanced questions
    let qs = [...questionsData.questions];
    const grouped = {};
    qs.forEach(q => { if (!grouped[q.category]) grouped[q.category] = []; grouped[q.category].push(q); });
    Object.values(grouped).forEach(arr => shuffleArray(arr));
    const balanced = [];
    const catKeys = Object.keys(grouped);
    let ci = 0;
    while (balanced.length < room.settings.questionCount && catKeys.length > 0) {
      const key = catKeys[ci % catKeys.length];
      if (grouped[key].length > 0) balanced.push(grouped[key].pop());
      else { catKeys.splice(catKeys.indexOf(key), 1); if (!catKeys.length) break; }
      ci++;
    }
    shuffleArray(balanced);

    room.questions = balanced;
    room.state = 'playing';
    room.currentQuestion = 0;
    room.players.forEach(p => { p.score = 0; p.answers = []; });

    io.to(room.code).emit('game-started', {
      totalQuestions: balanced.length,
      timePerQuestion: room.settings.timePerQuestion,
      players: room.players.map(p => p.name)
    });

    sendLiveQuestion(room);
  });

  // Player submits answer
  socket.on('submit-answer', ({ questionId, answerIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const currentQ = room.questions[room.currentQuestion];
    if (!currentQ || currentQ.id !== questionId) return;
    if (player.answers.find(a => a.questionId === questionId)) return;

    const isCorrect = answerIndex === currentQ.correct;
    const timeBonus = Math.max(0, room.questionDeadline - Date.now());
    const diffBonus = currentQ.difficulty === 'hard' ? 50 : currentQ.difficulty === 'medium' ? 25 : 0;
    const points = isCorrect ? (100 + Math.floor(timeBonus / 100) + diffBonus) : 0;

    player.answers.push({ questionId, answerIndex, isCorrect, points });
    if (isCorrect) player.score += points;

    // Tell everyone this player answered (but not what they picked)
    io.to(room.code).emit('player-answered', { playerName: player.name, answeredCount: room.players.filter(p => p.answers.find(a => a.questionId === questionId)).length, totalPlayers: room.players.length });

    // Check if all players answered
    if (room.players.every(p => p.answers.find(a => a.questionId === questionId))) {
      clearTimeout(room.questionTimer);
      revealLiveAnswer(room);
    }
  });

  // Teacher requests play again
  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    room.state = 'waiting';
    room.currentQuestion = -1;
    room.questions = [];
    room.players.forEach(p => { p.score = 0; p.answers = []; });
    io.to(room.code).emit('back-to-lobby', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });

  socket.on('disconnect', () => {
    const rc = socket.roomCode;
    if (!rc) return;
    const room = rooms.get(rc);
    if (!room) return;

    // Remove player
    room.players = room.players.filter(p => p.id !== socket.id);

    // If host left, delete room
    if (room.host === socket.id) {
      if (room.questionTimer) clearTimeout(room.questionTimer);
      io.to(rc).emit('host-left', { message: 'The teacher has left. Game ended.' });
      rooms.delete(rc);
      return;
    }

    // Update player list
    io.to(rc).emit('players-updated', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });
});

function sendLiveQuestion(room) {
  const q = room.questions[room.currentQuestion];
  if (!q) { endLiveGame(room); return; }

  const timeMs = room.settings.timePerQuestion * 1000;
  room.questionDeadline = Date.now() + timeMs;

  io.to(room.code).emit('new-question', {
    questionNumber: room.currentQuestion + 1,
    totalQuestions: room.questions.length,
    question: { id: q.id, category: q.category, difficulty: q.difficulty, question: q.question, options: q.options, reference: q.reference },
    timeLimit: room.settings.timePerQuestion
  });

  room.questionTimer = setTimeout(() => revealLiveAnswer(room), timeMs + 1000);
}

function revealLiveAnswer(room) {
  const q = room.questions[room.currentQuestion];
  if (!q) return;

  // Mark players who didn't answer
  room.players.forEach(p => {
    if (!p.answers.find(a => a.questionId === q.id)) {
      p.answers.push({ questionId: q.id, answerIndex: -1, isCorrect: false, points: 0 });
    }
  });

  // Build scoreboard sorted by score
  const scoreboard = room.players.map(p => ({
    name: p.name,
    score: p.score,
    lastAnswer: p.answers.find(a => a.questionId === q.id)
  })).sort((a, b) => b.score - a.score);

  io.to(room.code).emit('answer-revealed', {
    correctAnswer: q.correct,
    explanation: q.explanation,
    reference: q.reference,
    scoreboard
  });

  setTimeout(() => {
    room.currentQuestion++;
    if (room.currentQuestion < room.questions.length) sendLiveQuestion(room);
    else endLiveGame(room);
  }, 6000);
}

function endLiveGame(room) {
  room.state = 'results';
  const scoreboard = room.players.map(p => ({
    name: p.name,
    score: p.score,
    correctAnswers: p.answers.filter(a => a.isCorrect).length,
    totalQuestions: room.questions.length
  })).sort((a, b) => b.score - a.score);

  io.to(room.code).emit('game-over', {
    scoreboard,
    totalQuestions: room.questions.length
  });
}

// Cleanup stale rooms
setInterval(() => { for (const [code, room] of rooms) { if (room.teams.length === 0 || (room.startTime && Date.now() - room.startTime > 7200000)) rooms.delete(code); } }, 1800000);

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Bible Quiz Server running on port ${PORT}`);
  console.log(`  Questions: ${questionsData.questions.length} | Students: ${Object.keys(tracker.students).length}\n`);
});

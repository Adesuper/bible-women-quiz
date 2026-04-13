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
    // Scores for a specific date
    const dayScores = students.map(s => {
      const dayScore = s.scores.find(sc => sc.date === date);
      return {
        name: s.name,
        completed: !!dayScore,
        score: dayScore ? dayScore.score : 0,
        correct: dayScore ? dayScore.correct : 0,
        total: dayScore ? dayScore.total : 0,
        percentage: dayScore ? Math.round((dayScore.correct / dayScore.total) * 100) : 0,
        completedAt: dayScore ? dayScore.completedAt : null
      };
    }).sort((a, b) => b.score - a.score);
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
    const dayScore = s.scores.find(sc => sc.date === today);
    return { name: s.name, completed: !!dayScore, score: dayScore?.score || 0, correct: dayScore?.correct || 0, total: dayScore?.total || 0 };
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

  // Check if already submitted today
  if (tracker.students[nameKey]) {
    const existing = tracker.students[nameKey].scores.find(s => s.date === targetDate);
    if (existing) {
      return res.status(400).json({ message: 'You already completed today\'s assignment!' });
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
  tracker.students[nameKey].name = name; // Update display name
  tracker.students[nameKey].scores.push({
    date: targetDate,
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

// ============ TEAM PLAY (Socket.io) — unchanged from before ============
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('create-room', ({ playerName, teamName, questionCount, timePerQuestion, categories }) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode, host: socket.id,
      teams: [{ id: uuidv4(), name: teamName, players: [{ id: socket.id, name: playerName, isHost: true }], score: 0, answers: [] }],
      settings: { questionCount: questionCount || 15, timePerQuestion: timePerQuestion || 20, categories: categories || 'all' },
      state: 'waiting', currentQuestion: -1, questions: [], startTime: null, questionTimer: null, questionDeadline: null
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.teamId = room.teams[0].id;
    socket.emit('room-created', { roomCode, room: sanitizeRoom(room) });
  });

  socket.on('join-room', ({ roomCode, playerName, teamName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error-msg', { message: 'Room not found!' });
    if (room.state !== 'waiting') return socket.emit('error-msg', { message: 'Game in progress!' });
    let team = room.teams.find(t => t.name.toLowerCase() === teamName.toLowerCase());
    if (team) {
      if (team.players.length >= 5) return socket.emit('error-msg', { message: 'Team full!' });
      team.players.push({ id: socket.id, name: playerName, isHost: false });
    } else {
      if (room.teams.length >= 10) return socket.emit('error-msg', { message: 'Max teams reached!' });
      team = { id: uuidv4(), name: teamName, players: [{ id: socket.id, name: playerName, isHost: false }], score: 0, answers: [] };
      room.teams.push(team);
    }
    socket.join(code); socket.roomCode = code; socket.teamId = team.id;
    socket.emit('room-joined', { roomCode: code, room: sanitizeRoom(room), teamId: team.id });
    io.to(code).emit('room-updated', sanitizeRoom(room));
    io.to(code).emit('player-joined', { playerName, teamName: team.name, totalPlayers: room.teams.reduce((s, t) => s + t.players.length, 0) });
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    let qs = [...questionsData.questions];
    if (room.settings.categories !== 'all') {
      const cats = room.settings.categories.split(',');
      qs = qs.filter(q => cats.includes(q.category));
    }
    const grouped = {};
    qs.forEach(q => { if (!grouped[q.category]) grouped[q.category] = []; grouped[q.category].push(q); });
    Object.values(grouped).forEach(arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } });
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
    room.questions = balanced; room.state = 'playing'; room.currentQuestion = 0; room.startTime = Date.now();
    room.teams.forEach(t => { t.score = 0; t.answers = []; });
    io.to(room.code).emit('game-started', { totalQuestions: balanced.length, timePerQuestion: room.settings.timePerQuestion });
    sendQuestion(room);
  });

  socket.on('submit-answer', ({ questionId, answerIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const team = room.teams.find(t => t.id === socket.teamId);
    if (!team) return;
    const currentQ = room.questions[room.currentQuestion];
    if (!currentQ || currentQ.id !== questionId) return;
    if (team.answers.find(a => a.questionId === questionId)) return;
    const isCorrect = answerIndex === currentQ.correct;
    const timeBonus = Math.max(0, room.questionDeadline - Date.now());
    const diffBonus = currentQ.difficulty === 'hard' ? 50 : currentQ.difficulty === 'medium' ? 25 : 0;
    const points = isCorrect ? (100 + Math.floor(timeBonus / 100) + diffBonus) : 0;
    team.answers.push({ questionId, answerIndex, isCorrect, points, answeredBy: socket.id });
    if (isCorrect) team.score += points;
    io.to(room.code).emit('answer-received', { teamId: team.id, teamName: team.name, isCorrect, points, answerIndex });
    if (room.teams.every(t => t.answers.find(a => a.questionId === questionId))) { clearTimeout(room.questionTimer); revealAnswer(room); }
  });

  socket.on('disconnect', () => {
    const rc = socket.roomCode; if (!rc) return;
    const room = rooms.get(rc); if (!room) return;
    room.teams.forEach(t => { t.players = t.players.filter(p => p.id !== socket.id); });
    room.teams = room.teams.filter(t => t.players.length > 0);
    if (room.teams.length === 0) { if (room.questionTimer) clearTimeout(room.questionTimer); rooms.delete(rc); return; }
    if (room.host === socket.id && room.teams.length > 0) {
      room.host = room.teams[0].players[0].id; room.teams[0].players[0].isHost = true;
      io.to(rc).emit('new-host', { hostId: room.host, hostName: room.teams[0].players[0].name });
    }
    io.to(rc).emit('room-updated', sanitizeRoom(room));
  });
});

function sendQuestion(room) {
  const q = room.questions[room.currentQuestion];
  if (!q) { endGame(room); return; }
  const timeMs = room.settings.timePerQuestion * 1000;
  room.questionDeadline = Date.now() + timeMs;
  io.to(room.code).emit('new-question', {
    questionNumber: room.currentQuestion + 1, totalQuestions: room.questions.length,
    question: { id: q.id, category: q.category, difficulty: q.difficulty, question: q.question, options: q.options, reference: q.reference },
    timeLimit: room.settings.timePerQuestion
  });
  room.questionTimer = setTimeout(() => revealAnswer(room), timeMs + 1000);
}

function revealAnswer(room) {
  const q = room.questions[room.currentQuestion]; if (!q) return;
  room.teams.forEach(t => { if (!t.answers.find(a => a.questionId === q.id)) t.answers.push({ questionId: q.id, answerIndex: -1, isCorrect: false, points: 0, answeredBy: null }); });
  const scoreboard = room.teams.map(t => ({ teamId: t.id, teamName: t.name, score: t.score, lastAnswer: t.answers.find(a => a.questionId === q.id), playerCount: t.players.length })).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('answer-revealed', { correctAnswer: q.correct, explanation: q.explanation, reference: q.reference, scoreboard });
  setTimeout(() => { room.currentQuestion++; if (room.currentQuestion < room.questions.length) sendQuestion(room); else endGame(room); }, 6000);
}

function endGame(room) {
  room.state = 'results';
  const scoreboard = room.teams.map(t => ({
    teamId: t.id, teamName: t.name, score: t.score, correctAnswers: t.answers.filter(a => a.isCorrect).length,
    totalQuestions: room.questions.length, playerCount: t.players.length, players: t.players.map(p => p.name)
  })).sort((a, b) => b.score - a.score);
  const tips = ['Read a chapter together daily!', 'Speed matters — faster correct answers earn more points!', 'Review explanations for extra details!'];
  io.to(room.code).emit('game-over', { scoreboard, tips, totalQuestions: room.questions.length });
  room.state = 'waiting'; room.currentQuestion = -1; room.questions = [];
}

function sanitizeRoom(room) {
  return { code: room.code, teams: room.teams.map(t => ({ id: t.id, name: t.name, players: t.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })), score: t.score })), settings: room.settings, state: room.state, host: room.host };
}

// Cleanup stale rooms
setInterval(() => { for (const [code, room] of rooms) { if (room.teams.length === 0 || (room.startTime && Date.now() - room.startTime > 7200000)) rooms.delete(code); } }, 1800000);

// ============ START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Bible Quiz Server running on port ${PORT}`);
  console.log(`  Questions: ${questionsData.questions.length} | Students: ${Object.keys(tracker.students).length}\n`);
});

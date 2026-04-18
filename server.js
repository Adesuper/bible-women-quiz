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
  teachers: { pin: '2024' },
  studentPins: {
    'Caleb': '1111',
    'Karson': '2222',
    'Glenda': '3333',
    'Erlyssa': '4444',
    'Israel': '5555'
  },
  students: {},
  assignments: []
};

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
      // Migrate old format if needed
      if (saved.assignments && !Array.isArray(saved.assignments)) {
        const arr = [];
        Object.entries(saved.assignments).forEach(([date, data]) => {
          arr.push({ id: uuidv4(), date, label: 'Assignment', questionIds: data.questionIds, createdAt: data.createdAt, questionCount: data.questionCount });
        });
        saved.assignments = arr;
      }
      tracker = { ...tracker, ...saved };
      console.log(`Tracker loaded: ${Object.keys(tracker.students).length} students, ${tracker.assignments.length} assignments`);
    }
  } catch (e) { console.log('No existing tracker, starting fresh'); }
}

function saveTracker() {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
  } catch (e) { console.log('Save tracker error:', e.message); }
}

loadTracker();

// Auto-save every 2 minutes as backup
setInterval(() => saveTracker(), 120000);

// ============ HELPERS ============
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function pickBalancedQuestions(count) {
  const pool = [...questionsData.questions];

  // Separate by type
  const mc = shuffleArray(pool.filter(q => !q.type || q.type === 'multiple_choice'));
  const tf = shuffleArray(pool.filter(q => q.type === 'true_false'));
  const fb = shuffleArray(pool.filter(q => q.type === 'fill_blank'));

  // Aim for a mix: ~60% multiple choice, ~20% true/false, ~20% fill-blank
  const tfCount = Math.min(Math.round(count * 0.2), tf.length);
  const fbCount = Math.min(Math.round(count * 0.2), fb.length);
  const mcCount = count - tfCount - fbCount;

  // Pick from each type, balanced across categories
  function pickFromPool(items, num) {
    const grouped = {};
    items.forEach(q => { if (!grouped[q.category]) grouped[q.category] = []; grouped[q.category].push(q); });
    Object.values(grouped).forEach(arr => shuffleArray(arr));
    const picked = [];
    const catKeys = Object.keys(grouped);
    let idx = 0;
    while (picked.length < num && catKeys.length > 0) {
      const key = catKeys[idx % catKeys.length];
      if (grouped[key].length > 0) picked.push(grouped[key].pop());
      else { catKeys.splice(catKeys.indexOf(key), 1); if (!catKeys.length) break; }
      idx++;
    }
    return picked;
  }

  const selected = [
    ...pickFromPool(mc, mcCount),
    ...pickFromPool(tf, tfCount),
    ...pickFromPool(fb, fbCount)
  ];

  return shuffleArray(selected);
}

// ============ API: CATEGORIES & QUESTIONS ============
app.get('/api/categories', (req, res) => {
  res.json(questionsData.categories.map(cat => ({
    ...cat, questionCount: questionsData.questions.filter(q => q.category === cat.id).length
  })));
});

app.get('/api/stats', (req, res) => {
  const total = questionsData.questions.length;
  const byCat = {}, byDiff = { easy: 0, medium: 0, hard: 0 };
  questionsData.questions.forEach(q => { byCat[q.category] = (byCat[q.category] || 0) + 1; byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1; });
  res.json({ total, byCategory: byCat, byDifficulty: byDiff });
});

app.get('/api/questions/:category', (req, res) => {
  let qs = questionsData.questions.filter(q => q.category === req.params.category);
  if (req.query.difficulty && req.query.difficulty !== 'all') qs = qs.filter(q => q.difficulty === req.query.difficulty);
  res.json(shuffleArray(qs));
});

app.get('/api/questions/mix/random', (req, res) => {
  const count = parseInt(req.query.count) || 15;
  let qs = [...questionsData.questions];
  if (req.query.difficulty && req.query.difficulty !== 'all') qs = qs.filter(q => q.difficulty === req.query.difficulty);
  const shuffled = shuffleArray(qs);
  res.json(shuffled.slice(0, Math.min(count, shuffled.length)));
});

// ============ API: TEACHER ============
app.post('/api/teacher/login', (req, res) => {
  if (req.body.pin === tracker.teachers.pin) res.json({ success: true });
  else res.status(401).json({ success: false, message: 'Incorrect PIN' });
});

// Create an assignment (supports multiple per day + future dates)
app.post('/api/teacher/assign', (req, res) => {
  const { pin, date, label, questionCount, timer } = req.body;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const targetDate = date || todayStr();
  const count = questionCount || 10;
  const questions = pickBalancedQuestions(count);

  // Auto-label: count how many already exist for this date
  const existingForDate = tracker.assignments.filter(a => a.date === targetDate);
  const assignmentLabel = label || `Set ${existingForDate.length + 1}`;

  // Ensure no repeat questions from recent assignments (last 5)
  const recentAssignments = tracker.assignments.slice(-5);
  const recentIds = new Set(recentAssignments.flatMap(a => a.questionIds));
  let freshQuestions = questions.filter(q => !recentIds.has(q.id));
  // If not enough fresh questions, use all
  if (freshQuestions.length < count) freshQuestions = questions;

  const assignment = {
    id: uuidv4(),
    date: targetDate,
    label: assignmentLabel,
    questionIds: freshQuestions.slice(0, count).map(q => q.id),
    createdAt: new Date().toISOString(),
    questionCount: Math.min(count, freshQuestions.length),
    timer: timer || 45
  };

  tracker.assignments.push(assignment);
  saveTracker();

  res.json({
    success: true,
    id: assignment.id,
    date: targetDate,
    label: assignmentLabel,
    questionCount: questions.length,
    message: `"${assignmentLabel}" created for ${targetDate} with ${questions.length} questions`
  });
});

// Delete an assignment
app.delete('/api/teacher/assignment/:id', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });
  tracker.assignments = tracker.assignments.filter(a => a.id !== req.params.id);
  saveTracker();
  res.json({ success: true });
});

// Get all assignments
app.get('/api/teacher/assignments', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });
  res.json(tracker.assignments.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
});

// Get scores for a specific assignment
app.get('/api/teacher/scores/:assignmentId', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const assignmentId = req.params.assignmentId;
  const students = Object.values(tracker.students);

  const scores = students.map(s => {
    const attempts = s.scores.filter(sc => sc.assignmentId === assignmentId);
    const best = attempts.length > 0 ? attempts.reduce((b, c) => c.score > b.score ? c : b, attempts[0]) : null;
    return {
      name: s.name,
      completed: attempts.length > 0,
      attempts: attempts.map(a => ({ attempt: a.attempt, score: a.score, correct: a.correct, total: a.total, completedAt: a.completedAt })),
      bestScore: best ? best.score : 0,
      bestCorrect: best ? best.correct : 0,
      totalAttempts: attempts.length
    };
  }).filter(s => s.completed).sort((a, b) => b.bestScore - a.bestScore);

  res.json(scores);
});

// Teacher dashboard
app.get('/api/teacher/dashboard', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });

  const today = todayStr();
  const students = Object.values(tracker.students);
  const todayAssignments = tracker.assignments.filter(a => a.date === today);
  const allAssignments = tracker.assignments.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  // For each today assignment, get completion stats
  const todayDetails = todayAssignments.map(a => {
    const completions = students.filter(s => s.scores.some(sc => sc.assignmentId === a.id && sc.status === 'completed'));
    return {
      id: a.id,
      label: a.label,
      date: a.date,
      questionCount: a.questionCount,
      completedBy: completions.map(s => {
        const attempts = s.scores.filter(sc => sc.assignmentId === a.id && sc.status === 'completed');
        const best = attempts.length > 0 ? attempts.reduce((b, c) => c.score > b.score ? c : b, attempts[0]) : null;
        return {
          name: s.name,
          bestScore: best ? best.score : 0,
          bestCorrect: best ? best.correct : 0,
          total: best ? best.total : a.questionCount,
          totalAttempts: attempts.length,
          attempts: attempts.map(att => ({ attempt: att.attempt, score: att.score, correct: att.correct, total: att.total, completedAt: att.completedAt }))
        };
      }).sort((a, b) => b.bestScore - a.bestScore),
      totalCompletions: completions.length
    };
  });

  // Overall leaderboard — only count completed attempts
  const leaderboard = students.map(s => {
    const completed = s.scores.filter(sc => sc.status === 'completed');
    const totalCorrect = completed.reduce((sum, sc) => sum + sc.correct, 0);
    const totalAnswered = completed.reduce((sum, sc) => sum + sc.total, 0);
    const uniqueAssignments = new Set(completed.map(sc => sc.assignmentId)).size;
    return {
      name: s.name,
      assignmentsCompleted: uniqueAssignments,
      accuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0
    };
  }).sort((a, b) => b.assignmentsCompleted - a.assignmentsCompleted || b.accuracy - a.accuracy);

  res.json({
    today,
    todayAssignments: todayDetails,
    allAssignments,
    totalStudents: students.length,
    leaderboard,
    totalAssignments: tracker.assignments.length
  });
});

// ============ API: STUDENT PIN VERIFICATION ============
app.post('/api/student/verify', (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ verified: false, message: 'Name and PIN required' });

  const studentPin = tracker.studentPins[name];
  if (!studentPin) {
    // Not a registered kid — "Someone else" option, no PIN needed
    return res.json({ verified: true });
  }
  if (pin === studentPin) {
    return res.json({ verified: true });
  }
  return res.status(401).json({ verified: false, message: 'Incorrect PIN. Try again.' });
});

// ============ API: STUDENT DAILY ============

// Get available assignments for kids
app.get('/api/daily/available', (req, res) => {
  const today = todayStr();
  const available = tracker.assignments
    .filter(a => a.date <= today)  // Show today and past (not future)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  // Don't send question IDs to students
  res.json(available.map(a => ({
    id: a.id, date: a.date, label: a.label, questionCount: a.questionCount
  })));
});

// Get questions for a specific assignment
app.get('/api/daily/assignment/:id', (req, res) => {
  const assignment = tracker.assignments.find(a => a.id === req.params.id);
  if (!assignment) return res.json({ found: false, message: 'Assignment not found.' });

  const questions = assignment.questionIds
    .map(id => questionsData.questions.find(q => q.id === id))
    .filter(Boolean)
    .map(q => ({ id: q.id, category: q.category, difficulty: q.difficulty, type: q.type || 'multiple_choice', question: q.question, options: q.options, reference: q.reference }));

  res.json({ found: true, id: assignment.id, date: assignment.date, label: assignment.label, questions, questionCount: questions.length, timer: assignment.timer || 45 });
});

// Register that a student STARTED an attempt (counts even if they leave)
app.post('/api/daily/start', (req, res) => {
  const { studentName, assignmentId } = req.body;
  if (!studentName || !assignmentId) return res.status(400).json({ message: 'Missing fields' });

  const assignment = tracker.assignments.find(a => a.id === assignmentId);
  if (!assignment) return res.status(404).json({ message: 'Assignment not found' });

  const name = studentName.trim();
  const nameKey = name.toLowerCase();

  if (!tracker.students[nameKey]) tracker.students[nameKey] = { name, scores: [] };
  tracker.students[nameKey].name = name;

  const allAttempts = tracker.students[nameKey].scores.filter(s => s.assignmentId === assignmentId);
  const completedAttempts = allAttempts.filter(s => s.status === 'completed');
  const pendingAttempt = allAttempts.find(s => s.status === 'started');

  if (completedAttempts.length >= 3) {
    return res.status(400).json({ message: 'You\'ve used all 3 attempts for this assignment!', attemptsUsed: 3 });
  }

  // If there's already a pending (abandoned) attempt, reuse it instead of creating a new one
  if (pendingAttempt) {
    pendingAttempt.startedAt = new Date().toISOString();
    saveTracker();
    return res.json({ success: true, attempt: pendingAttempt.attempt, attemptsRemaining: 3 - completedAttempts.length });
  }

  // Create a new pending attempt
  const attemptNum = completedAttempts.length + 1;
  tracker.students[nameKey].scores.push({
    assignmentId, attempt: attemptNum, score: 0, correct: 0, total: assignment.questionCount,
    completedAt: null, status: 'started', startedAt: new Date().toISOString()
  });
  saveTracker();

  res.json({ success: true, attempt: attemptNum, attemptsRemaining: 3 - attemptNum });
});

// Submit answers for an assignment (completes a started attempt)
app.post('/api/daily/submit', (req, res) => {
  const { studentName, assignmentId, answers } = req.body;
  if (!studentName || !assignmentId || !answers) return res.status(400).json({ message: 'Missing required fields' });

  const assignment = tracker.assignments.find(a => a.id === assignmentId);
  if (!assignment) return res.status(404).json({ message: 'Assignment not found' });

  const name = studentName.trim();
  const nameKey = name.toLowerCase();

  if (!tracker.students[nameKey]) tracker.students[nameKey] = { name, scores: [] };

  // Find the latest started (incomplete) attempt, or check if maxed out
  const allAttempts = tracker.students[nameKey].scores.filter(s => s.assignmentId === assignmentId);
  let pendingAttempt = allAttempts.find(a => a.status === 'started');

  if (!pendingAttempt) {
    // No pending attempt — they may have refreshed. Check if they can still submit.
    if (allAttempts.filter(a => a.status === 'completed').length >= 3) {
      return res.status(400).json({ message: 'You\'ve used all 3 attempts for this assignment!' });
    }
  }

  // Grade
  let correct = 0, score = 0;
  const results = [];
  answers.forEach(({ questionId, answerIndex }) => {
    const q = questionsData.questions.find(qu => qu.id === questionId);
    if (!q) return;
    const isCorrect = answerIndex === q.correct;
    if (isCorrect) { correct++; score += 100; }
    results.push({ questionId, isCorrect, correctAnswer: q.correct, explanation: q.explanation, reference: q.reference });
  });

  tracker.students[nameKey].name = name;

  if (pendingAttempt) {
    // Update the pending attempt
    pendingAttempt.score = score;
    pendingAttempt.correct = correct;
    pendingAttempt.total = assignment.questionCount;
    pendingAttempt.completedAt = new Date().toISOString();
    pendingAttempt.status = 'completed';
  } else {
    // Create a completed attempt directly (edge case: started without /start call)
    const attemptNum = allAttempts.length + 1;
    tracker.students[nameKey].scores.push({
      assignmentId, attempt: attemptNum, score, correct, total: assignment.questionCount,
      completedAt: new Date().toISOString(), status: 'completed'
    });
  }
  saveTracker();

  const attemptNum = pendingAttempt ? pendingAttempt.attempt : allAttempts.length + 1;
  res.json({ success: true, score, correct, total: assignment.questionCount, percentage: Math.round((correct / assignment.questionCount) * 100), results, attempt: attemptNum });
});

// Check how many attempts a student has for an assignment
app.get('/api/daily/attempts', (req, res) => {
  const { name, assignmentId } = req.query;
  if (!name || !assignmentId) return res.json({ attempts: 0 });
  const nameKey = name.trim().toLowerCase();
  const student = tracker.students[nameKey];
  if (!student) return res.json({ attempts: 0 });
  const completed = student.scores.filter(s => s.assignmentId === assignmentId && s.status === 'completed').length;
  res.json({ attempts: completed });
});

app.get('/api/daily/leaderboard', (req, res) => {
  const students = Object.values(tracker.students);
  res.json(students.map(s => {
    const totalScore = s.scores.reduce((sum, sc) => sum + sc.score, 0);
    const totalCorrect = s.scores.reduce((sum, sc) => sum + sc.correct, 0);
    const totalAnswered = s.scores.reduce((sum, sc) => sum + sc.total, 0);
    return { name: s.name, totalScore, daysCompleted: new Set(s.scores.map(sc => sc.assignmentId)).size, accuracy: totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0 };
  }).sort((a, b) => b.totalScore - a.totalScore));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', questions: questionsData.questions.length, students: Object.keys(tracker.students).length, assignments: tracker.assignments.length });
});

// ============ API: DATA EXPORT (backup) ============
app.get('/api/teacher/export', (req, res) => {
  const { pin } = req.query;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });
  res.json(tracker);
});

app.post('/api/teacher/import', (req, res) => {
  const { pin, data } = req.body;
  if (pin !== tracker.teachers.pin) return res.status(401).json({ message: 'Unauthorized' });
  if (data && data.students && data.assignments) {
    tracker = { ...tracker, ...data };
    saveTracker();
    res.json({ success: true, message: 'Data imported successfully' });
  } else {
    res.status(400).json({ message: 'Invalid data format' });
  }
});

// ============ LIVE QUIZ (Socket.io) ============
const rooms = new Map();

io.on('connection', (socket) => {

  socket.on('host-game', ({ questionCount, timePerQuestion }) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode, host: socket.id, players: [],
      settings: { questionCount: questionCount || 10, timePerQuestion: timePerQuestion || 20 },
      state: 'waiting', currentQuestion: -1, questions: [], questionTimer: null, questionDeadline: null,
      paused: false, pausedTimeRemaining: 0, usedQuestionIds: []
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('room-created', { roomCode, players: [] });
  });

  socket.on('join-game', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error-msg', { message: 'Room not found!' });
    if (room.state !== 'waiting') return socket.emit('error-msg', { message: 'Game already started! Wait for the next round.' });
    if (room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase()))
      return socket.emit('error-msg', { message: `${playerName} is already in the game!` });

    room.players.push({ id: socket.id, name: playerName, score: 0, answers: [] });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined-game', { roomCode: code, playerName, players: room.players.map(p => p.name) });
    io.to(code).emit('players-updated', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    if (room.players.length === 0) return socket.emit('error-msg', { message: 'No players have joined yet!' });

    // Pick questions, excluding previously used ones in this session
    let pool = questionsData.questions.filter(q => !room.usedQuestionIds.includes(q.id));
    if (pool.length < room.settings.questionCount) {
      // Not enough fresh questions, reset and use all
      room.usedQuestionIds = [];
      pool = [...questionsData.questions];
    }

    const grouped = {};
    pool.forEach(q => { if (!grouped[q.category]) grouped[q.category] = []; grouped[q.category].push(q); });
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

    // Track used questions so next round is different
    room.usedQuestionIds.push(...balanced.map(q => q.id));

    room.questions = balanced;
    room.state = 'playing';
    room.currentQuestion = 0;
    room.paused = false;
    room.players.forEach(p => { p.score = 0; p.answers = []; });

    io.to(room.code).emit('game-started', { totalQuestions: balanced.length, timePerQuestion: room.settings.timePerQuestion, players: room.players.map(p => p.name) });
    sendLiveQuestion(room);
  });

  // PAUSE / RESUME
  socket.on('pause-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id || room.state !== 'playing' || room.paused) return;

    room.paused = true;
    room.pausedTimeRemaining = Math.max(0, Math.floor((room.questionDeadline - Date.now()) / 1000));
    clearTimeout(room.questionTimer);

    io.to(room.code).emit('game-paused', { timeRemaining: room.pausedTimeRemaining });
  });

  socket.on('resume-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id || !room.paused) return;

    room.paused = false;
    const timeMs = room.pausedTimeRemaining * 1000;
    room.questionDeadline = Date.now() + timeMs;

    io.to(room.code).emit('game-resumed', { timeRemaining: room.pausedTimeRemaining });

    room.questionTimer = setTimeout(() => revealLiveAnswer(room), timeMs + 1000);
  });

  socket.on('submit-answer', ({ questionId, answerIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing' || room.paused) return;

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

    io.to(room.code).emit('player-answered', {
      playerName: player.name,
      answeredCount: room.players.filter(p => p.answers.find(a => a.questionId === questionId)).length,
      totalPlayers: room.players.length
    });

    if (room.players.every(p => p.answers.find(a => a.questionId === questionId))) {
      clearTimeout(room.questionTimer);
      revealLiveAnswer(room);
    }
  });

  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    room.state = 'waiting';
    room.currentQuestion = -1;
    room.questions = [];
    room.paused = false;
    room.players.forEach(p => { p.score = 0; p.answers = []; });
    io.to(room.code).emit('back-to-lobby', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });

  socket.on('disconnect', () => {
    const rc = socket.roomCode;
    if (!rc) return;
    const room = rooms.get(rc);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.host === socket.id) {
      if (room.questionTimer) clearTimeout(room.questionTimer);
      io.to(rc).emit('host-left', { message: 'The teacher has left.' });
      rooms.delete(rc);
      return;
    }
    io.to(rc).emit('players-updated', { players: room.players.map(p => ({ name: p.name, connected: true })) });
  });
});

function sendLiveQuestion(room) {
  const q = room.questions[room.currentQuestion];
  if (!q) { endLiveGame(room); return; }
  const timeMs = room.settings.timePerQuestion * 1000;
  room.questionDeadline = Date.now() + timeMs;
  io.to(room.code).emit('new-question', {
    questionNumber: room.currentQuestion + 1, totalQuestions: room.questions.length,
    question: { id: q.id, category: q.category, difficulty: q.difficulty, question: q.question, options: q.options, reference: q.reference },
    timeLimit: room.settings.timePerQuestion
  });
  room.questionTimer = setTimeout(() => revealLiveAnswer(room), timeMs + 1000);
}

function revealLiveAnswer(room) {
  const q = room.questions[room.currentQuestion];
  if (!q) return;
  room.players.forEach(p => { if (!p.answers.find(a => a.questionId === q.id)) p.answers.push({ questionId: q.id, answerIndex: -1, isCorrect: false, points: 0 }); });
  const scoreboard = room.players.map(p => ({ name: p.name, score: p.score, lastAnswer: p.answers.find(a => a.questionId === q.id) })).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('answer-revealed', { correctAnswer: q.correct, explanation: q.explanation, reference: q.reference, scoreboard });
  setTimeout(() => { room.currentQuestion++; if (room.currentQuestion < room.questions.length) sendLiveQuestion(room); else endLiveGame(room); }, 6000);
}

function endLiveGame(room) {
  room.state = 'results';
  const scoreboard = room.players.map(p => ({ name: p.name, score: p.score, correctAnswers: p.answers.filter(a => a.isCorrect).length, totalQuestions: room.questions.length })).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game-over', { scoreboard, totalQuestions: room.questions.length });
}

setInterval(() => { for (const [code, room] of rooms) { if (room.players.length === 0 || (room.startTime && Date.now() - room.startTime > 7200000)) rooms.delete(code); } }, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Bible Quiz Server running on port ${PORT}`);
  console.log(`  Questions: ${questionsData.questions.length} | Students: ${Object.keys(tracker.students).length} | Assignments: ${tracker.assignments.length}\n`);
});

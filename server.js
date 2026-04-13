const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Allow larger payloads for question data
  maxHttpBufferSize: 1e6
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============ LOAD ALL QUESTIONS ============
function loadAllQuestions() {
  const mainFile = path.join(__dirname, 'data', 'questions.json');
  const mainData = JSON.parse(fs.readFileSync(mainFile, 'utf8'));

  // Load any additional batch files
  const dataDir = path.join(__dirname, 'data');
  const batchFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('questions-batch') && f.endsWith('.json'));

  batchFiles.forEach(file => {
    try {
      const batchData = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      // Batch files are arrays of question objects
      if (Array.isArray(batchData)) {
        mainData.questions.push(...batchData);
      }
    } catch (e) {
      console.log(`Warning: Could not load ${file}:`, e.message);
    }
  });

  // Deduplicate by ID
  const seen = new Set();
  mainData.questions = mainData.questions.filter(q => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });

  console.log(`Loaded ${mainData.questions.length} total questions from ${1 + batchFiles.length} file(s)`);
  return mainData;
}

const questionsData = loadAllQuestions();

// ============ API ROUTES ============

// Get all categories with question counts
app.get('/api/categories', (req, res) => {
  const cats = questionsData.categories.map(cat => {
    const count = questionsData.questions.filter(q => q.category === cat.id).length;
    return { ...cat, questionCount: count };
  });
  res.json(cats);
});

// Get total stats
app.get('/api/stats', (req, res) => {
  const total = questionsData.questions.length;
  const byCat = {};
  const byDiff = { easy: 0, medium: 0, hard: 0 };
  questionsData.questions.forEach(q => {
    byCat[q.category] = (byCat[q.category] || 0) + 1;
    byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  });
  res.json({ total, byCategory: byCat, byDifficulty: byDiff });
});

// Get questions by category (for practice mode)
app.get('/api/questions/:category', (req, res) => {
  const { category } = req.params;
  const difficulty = req.query.difficulty || 'all';
  let questions = questionsData.questions.filter(q => q.category === category);
  if (difficulty !== 'all') {
    questions = questions.filter(q => q.difficulty === difficulty);
  }
  // Shuffle questions
  questions = shuffleArray([...questions]);
  res.json(questions);
});

// Get random mixed questions
app.get('/api/questions/mix/random', (req, res) => {
  const count = parseInt(req.query.count) || 15;
  const difficulty = req.query.difficulty || 'all';
  let questions = [...questionsData.questions];
  if (difficulty !== 'all') {
    questions = questions.filter(q => q.difficulty === difficulty);
  }
  const shuffled = shuffleArray(questions);
  // If count is very large (9999), return all
  const limit = count >= questions.length ? questions.length : count;
  res.json(shuffled.slice(0, limit));
});

// Health check for Render.com
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', questions: questionsData.questions.length });
});

// ============ TEAM PLAY (Socket.io) ============

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('create-room', ({ playerName, teamName, questionCount, timePerQuestion, categories }) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: socket.id,
      teams: [
        {
          id: uuidv4(),
          name: teamName,
          players: [{ id: socket.id, name: playerName, isHost: true }],
          score: 0,
          answers: []
        }
      ],
      settings: {
        questionCount: questionCount || 15,
        timePerQuestion: timePerQuestion || 20,
        categories: categories || 'all'
      },
      state: 'waiting',
      currentQuestion: -1,
      questions: [],
      startTime: null,
      questionTimer: null,
      questionDeadline: null
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.teamId = room.teams[0].id;

    socket.emit('room-created', {
      roomCode,
      room: sanitizeRoom(room)
    });

    console.log(`Room ${roomCode} created by ${playerName}`);
  });

  socket.on('join-room', ({ roomCode, playerName, teamName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error-msg', { message: 'Room not found! Check the code and try again.' });
      return;
    }

    if (room.state !== 'waiting') {
      socket.emit('error-msg', { message: 'Game already in progress! Wait for the next round.' });
      return;
    }

    let team = room.teams.find(t => t.name.toLowerCase() === teamName.toLowerCase());

    if (team) {
      if (team.players.length >= 5) {
        socket.emit('error-msg', { message: 'That team is full! (Max 5 players). Try another team name.' });
        return;
      }
      team.players.push({ id: socket.id, name: playerName, isHost: false });
    } else {
      if (room.teams.length >= 10) {
        socket.emit('error-msg', { message: 'Maximum 10 teams allowed!' });
        return;
      }
      team = {
        id: uuidv4(),
        name: teamName,
        players: [{ id: socket.id, name: playerName, isHost: false }],
        score: 0,
        answers: []
      };
      room.teams.push(team);
    }

    socket.join(code);
    socket.roomCode = code;
    socket.teamId = team.id;

    socket.emit('room-joined', {
      roomCode: code,
      room: sanitizeRoom(room),
      teamId: team.id
    });

    io.to(code).emit('room-updated', sanitizeRoom(room));
    io.to(code).emit('player-joined', {
      playerName,
      teamName: team.name,
      totalPlayers: room.teams.reduce((sum, t) => sum + t.players.length, 0)
    });

    console.log(`${playerName} joined room ${code} on team "${team.name}"`);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;

    let questions = [...questionsData.questions];
    if (room.settings.categories !== 'all') {
      const cats = room.settings.categories.split(',');
      questions = questions.filter(q => cats.includes(q.category));
    }

    // Ensure balanced category representation
    const grouped = {};
    questions.forEach(q => {
      if (!grouped[q.category]) grouped[q.category] = [];
      grouped[q.category].push(q);
    });

    // Shuffle each category
    Object.values(grouped).forEach(arr => shuffleArray(arr));

    // Round-robin pick from categories for balance
    const balanced = [];
    const catKeys = Object.keys(grouped);
    let catIndex = 0;
    while (balanced.length < room.settings.questionCount && catKeys.length > 0) {
      const key = catKeys[catIndex % catKeys.length];
      if (grouped[key].length > 0) {
        balanced.push(grouped[key].pop());
      } else {
        catKeys.splice(catIndex % catKeys.length, 1);
        if (catKeys.length === 0) break;
      }
      catIndex++;
    }

    // Final shuffle so categories aren't in order
    shuffleArray(balanced);

    room.questions = balanced;
    room.state = 'playing';
    room.currentQuestion = 0;
    room.startTime = Date.now();

    room.teams.forEach(team => {
      team.score = 0;
      team.answers = [];
    });

    io.to(room.code).emit('game-started', {
      totalQuestions: balanced.length,
      timePerQuestion: room.settings.timePerQuestion
    });

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

    team.answers.push({
      questionId,
      answerIndex,
      isCorrect,
      points,
      answeredBy: socket.id
    });

    if (isCorrect) {
      team.score += points;
    }

    io.to(room.code).emit('answer-received', {
      teamId: team.id,
      teamName: team.name,
      isCorrect,
      points,
      answerIndex
    });

    const allAnswered = room.teams.every(t =>
      t.answers.find(a => a.questionId === questionId)
    );

    if (allAnswered) {
      clearTimeout(room.questionTimer);
      revealAnswer(room);
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    room.teams.forEach(team => {
      team.players = team.players.filter(p => p.id !== socket.id);
    });

    room.teams = room.teams.filter(t => t.players.length > 0);

    if (room.teams.length === 0) {
      if (room.questionTimer) clearTimeout(room.questionTimer);
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} deleted (empty)`);
      return;
    }

    if (room.host === socket.id && room.teams.length > 0) {
      room.host = room.teams[0].players[0].id;
      room.teams[0].players[0].isHost = true;
      io.to(roomCode).emit('new-host', {
        hostId: room.host,
        hostName: room.teams[0].players[0].name
      });
    }

    io.to(roomCode).emit('room-updated', sanitizeRoom(room));
    console.log(`Player ${socket.id} disconnected from room ${roomCode}`);
  });
});

// ============ GAME LOGIC ============

function sendQuestion(room) {
  const question = room.questions[room.currentQuestion];
  if (!question) {
    endGame(room);
    return;
  }

  const timeMs = room.settings.timePerQuestion * 1000;
  room.questionDeadline = Date.now() + timeMs;

  io.to(room.code).emit('new-question', {
    questionNumber: room.currentQuestion + 1,
    totalQuestions: room.questions.length,
    question: {
      id: question.id,
      category: question.category,
      difficulty: question.difficulty,
      question: question.question,
      options: question.options,
      reference: question.reference
    },
    timeLimit: room.settings.timePerQuestion
  });

  room.questionTimer = setTimeout(() => {
    revealAnswer(room);
  }, timeMs + 1000);
}

function revealAnswer(room) {
  const question = room.questions[room.currentQuestion];
  if (!question) return;

  room.teams.forEach(team => {
    if (!team.answers.find(a => a.questionId === question.id)) {
      team.answers.push({
        questionId: question.id,
        answerIndex: -1,
        isCorrect: false,
        points: 0,
        answeredBy: null
      });
    }
  });

  const scoreboard = room.teams
    .map(t => ({
      teamId: t.id,
      teamName: t.name,
      score: t.score,
      lastAnswer: t.answers.find(a => a.questionId === question.id),
      playerCount: t.players.length
    }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit('answer-revealed', {
    correctAnswer: question.correct,
    explanation: question.explanation,
    reference: question.reference,
    scoreboard
  });

  setTimeout(() => {
    room.currentQuestion++;
    if (room.currentQuestion < room.questions.length) {
      sendQuestion(room);
    } else {
      endGame(room);
    }
  }, 6000);
}

function endGame(room) {
  room.state = 'results';

  const finalScoreboard = room.teams
    .map(t => ({
      teamId: t.id,
      teamName: t.name,
      score: t.score,
      correctAnswers: t.answers.filter(a => a.isCorrect).length,
      totalQuestions: room.questions.length,
      playerCount: t.players.length,
      players: t.players.map(p => p.name)
    }))
    .sort((a, b) => b.score - a.score);

  const tips = generateTips(room, finalScoreboard);

  io.to(room.code).emit('game-over', {
    scoreboard: finalScoreboard,
    tips,
    totalQuestions: room.questions.length
  });

  room.state = 'waiting';
  room.currentQuestion = -1;
  room.questions = [];
}

function generateTips(room, scoreboard) {
  const tips = [];

  const categoryStats = {};
  room.teams.forEach(team => {
    team.answers.forEach(answer => {
      const q = room.questions.find(qu => qu.id === answer.questionId);
      if (!q) return;
      if (!categoryStats[q.category]) categoryStats[q.category] = { correct: 0, total: 0 };
      categoryStats[q.category].total++;
      if (answer.isCorrect) categoryStats[q.category].correct++;
    });
  });

  let weakestCat = null;
  let weakestRate = 1;
  const catNames = {
    esther: 'Queen Esther (Esther 1-10)',
    ruth: 'Ruth (Ruth 1-4)',
    hannah: 'Hannah (1 Samuel 1-2)',
    abigail: 'Abigail (1 Samuel 25)',
    deborah: 'Deborah (Judges 4-5)',
    mary_elizabeth: 'Mary & Elizabeth (Luke 1, John 19)'
  };

  Object.entries(categoryStats).forEach(([cat, stats]) => {
    const rate = stats.total > 0 ? stats.correct / stats.total : 0;
    if (rate < weakestRate) {
      weakestRate = rate;
      weakestCat = cat;
    }
  });

  if (weakestCat && weakestRate < 0.6) {
    tips.push(`Focus on ${catNames[weakestCat] || weakestCat} — this was the toughest category today!`);
  }

  const hardQuestions = room.questions.filter(q => q.difficulty === 'hard');
  const hardCorrect = room.teams.reduce((sum, team) => {
    return sum + team.answers.filter(a => {
      const q = hardQuestions.find(hq => hq.id === a.questionId);
      return q && a.isCorrect;
    }).length;
  }, 0);
  const hardTotal = hardQuestions.length * room.teams.length;
  if (hardTotal > 0 && hardCorrect / hardTotal < 0.4) {
    tips.push('Hard questions were challenging! Pay attention to exact numbers, names of minor characters, and specific NKJV wording.');
  }

  tips.push('Read a chapter together as a team each day and quiz each other on details!');
  tips.push('Speed matters! The faster you answer correctly, the more bonus points you earn.');
  tips.push('Pay attention to the explanations — they contain extra details for future quizzes!');

  return tips;
}

// ============ HELPERS ============

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    teams: room.teams.map(t => ({
      id: t.id,
      name: t.name,
      players: t.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
      score: t.score
    })),
    settings: room.settings,
    state: room.state,
    host: room.host
  };
}

// ============ CLEANUP stale rooms every 30 minutes ============
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Delete rooms older than 2 hours or empty rooms
    if (room.teams.length === 0 || (room.startTime && now - room.startTime > 7200000)) {
      rooms.delete(code);
      console.log(`Cleaned up stale room ${code}`);
    }
  }
}, 1800000);

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ===================================================');
  console.log('  |     WOMEN OF THE BIBLE QUIZ — CONFERENCE EDITION |');
  console.log('  |     Server is running!                           |');
  console.log(`  |     Local:  http://localhost:${PORT}                 |`);
  console.log('  |     Share the URL with your team!                |');
  console.log(`  |     Questions loaded: ${questionsData.questions.length}                      |`);
  console.log('  ===================================================');
  console.log('');
});

// ============ SOCKET CONNECTION ============
const socket = io();

// ============ STATE ============
let myTeamId = null;
let roomCode = null;
let isHost = false;
let currentQuestionData = null;
let teamTimerInterval = null;
let teamTimeLeft = 20;
let teamAnswered = false;
let totalQuestions = 15;
let currentQuestionNum = 0;

// ============ SOCKET EVENT HANDLERS ============

socket.on('room-created', ({ roomCode: code, room }) => {
  roomCode = code;
  isHost = true;
  myTeamId = room.teams[0].id;
  showWaitingRoom(room);
  showToast(`Game room created! Code: ${code}`, 'success');
});

socket.on('room-joined', ({ roomCode: code, room, teamId }) => {
  roomCode = code;
  myTeamId = teamId;
  isHost = false;
  showWaitingRoom(room);
  showToast('You joined the game!', 'success');
});

socket.on('room-updated', (room) => {
  updateWaitingRoom(room);
});

socket.on('player-joined', ({ playerName, teamName, totalPlayers }) => {
  showToast(`${playerName} joined team "${teamName}"! (${totalPlayers} players total)`, 'info');
});

socket.on('new-host', ({ hostName }) => {
  showToast(`${hostName} is now the host`, 'info');
});

socket.on('error-msg', ({ message }) => {
  showToast(message, 'error');
});

socket.on('game-started', ({ totalQuestions: total, timePerQuestion }) => {
  totalQuestions = total;
  teamTimeLeft = timePerQuestion;
  currentQuestionNum = 0;
  showSection('teamQuizSection');
  showToast('Game is starting! Good luck!', 'success');
});

socket.on('new-question', ({ questionNumber, totalQuestions: total, question, timeLimit }) => {
  currentQuestionNum = questionNumber;
  totalQuestions = total;
  teamTimeLeft = timeLimit;
  teamAnswered = false;
  currentQuestionData = question;

  renderTeamQuestion(question, questionNumber, total, timeLimit);
});

socket.on('answer-received', ({ teamId, teamName, isCorrect, points, answerIndex }) => {
  if (teamId === myTeamId) {
    // Our team's answer was received
    const statusText = document.getElementById('answerStatusText');
    if (isCorrect) {
      statusText.textContent = `Your team answered correctly! +${points} points!`;
      statusText.style.color = '#00b894';
    } else {
      statusText.textContent = 'Your team got it wrong... Wait for the correct answer!';
      statusText.style.color = '#d63031';
    }
  }
});

socket.on('answer-revealed', ({ correctAnswer, explanation, reference, scoreboard }) => {
  clearInterval(teamTimerInterval);
  revealTeamAnswer(correctAnswer, explanation, reference, scoreboard);
});

socket.on('game-over', ({ scoreboard, tips, totalQuestions: total }) => {
  showFinalResults(scoreboard, tips, total);
});

// ============ ROOM CREATION / JOINING ============

function createRoom() {
  const playerName = document.getElementById('createPlayerName').value.trim();
  const teamName = document.getElementById('createTeamName').value.trim();
  const questionCount = parseInt(document.getElementById('questionCountSelect').value);
  const timePerQuestion = parseInt(document.getElementById('timeSelect').value);

  if (!playerName) {
    showToast('Please enter your name!', 'error');
    return;
  }
  if (!teamName) {
    showToast('Please enter a team name!', 'error');
    return;
  }

  socket.emit('create-room', {
    playerName,
    teamName,
    questionCount,
    timePerQuestion,
    categories: 'all'
  });
}

function joinRoom() {
  const playerName = document.getElementById('joinPlayerName').value.trim();
  const teamName = document.getElementById('joinTeamName').value.trim();
  const code = document.getElementById('joinRoomCode').value.trim().toUpperCase();

  if (!playerName) {
    showToast('Please enter your name!', 'error');
    return;
  }
  if (!teamName) {
    showToast('Please enter a team name!', 'error');
    return;
  }
  if (!code || code.length < 4) {
    showToast('Please enter a valid room code!', 'error');
    return;
  }

  socket.emit('join-room', { roomCode: code, playerName, teamName });
}

function startGame() {
  socket.emit('start-game');
}

// ============ WAITING ROOM ============

function showWaitingRoom(room) {
  showSection('waitingSection');
  document.getElementById('roomCodeDisplay').textContent = room.code;
  updateWaitingRoom(room);
}

function updateWaitingRoom(room) {
  // Check if I am host
  isHost = room.host === socket.id;

  if (isHost) {
    document.getElementById('hostControls').classList.remove('hidden');
    document.getElementById('guestMessage').classList.add('hidden');
  } else {
    document.getElementById('hostControls').classList.add('hidden');
    document.getElementById('guestMessage').classList.remove('hidden');
  }

  // Render teams
  const teamsList = document.getElementById('teamsList');
  teamsList.innerHTML = '';

  const teamColors = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#e17055', '#00b894', '#0984e3', '#d63031'];

  room.teams.forEach((team, index) => {
    const card = document.createElement('div');
    card.className = 'team-card';
    card.style.borderLeftColor = teamColors[index % teamColors.length];

    let playerHTML = '';
    team.players.forEach(p => {
      const hostBadge = p.isHost ? ' (Host)' : '';
      const isMe = p.id === socket.id ? ' (You)' : '';
      playerHTML += `<li>${p.name}${hostBadge}${isMe}</li>`;
    });

    card.innerHTML = `
      <h4>${team.name}</h4>
      <ul class="player-list">${playerHTML}</ul>
      <div style="font-size: 0.8rem; color: var(--text-light); margin-top: 8px;">${team.players.length}/5 players</div>
    `;
    teamsList.appendChild(card);
  });
}

// ============ TEAM QUIZ ============

function renderTeamQuestion(question, questionNumber, total, timeLimit) {
  // Hide mini scoreboard
  document.getElementById('miniScoreboard').classList.add('hidden');
  document.getElementById('answerStatusText').textContent = '';

  // Update header
  document.getElementById('tQuestionCount').textContent = `${questionNumber}/${total}`;
  document.getElementById('tProgressBar').style.width = `${((questionNumber - 1) / total) * 100}%`;

  // Category info
  const catNames = {
    esther: '👑 Esther',
    ruth: '🌾 Ruth',
    hannah: '🙏 Hannah',
    abigail: '🕊️ Abigail',
    deborah: '⚔️ Deborah',
    mary_elizabeth: '⭐ Mary & Elizabeth'
  };

  document.getElementById('tQuestionMeta').innerHTML = `
    <span class="badge badge-category">${catNames[question.category] || question.category}</span>
    <span class="badge badge-${question.difficulty}">${question.difficulty.charAt(0).toUpperCase() + question.difficulty.slice(1)}</span>
  `;

  document.getElementById('tQuestionText').textContent = question.question;

  // Options
  const grid = document.getElementById('tOptionsGrid');
  grid.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

  question.options.forEach((option, index) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `
      <span class="option-letter">${letters[index]}</span>
      <span>${option}</span>
    `;
    btn.onclick = () => submitTeamAnswer(index);
    grid.appendChild(btn);
  });

  // Hide explanation
  document.getElementById('tExplanationBox').classList.remove('show');

  // Start timer
  startTeamTimer(timeLimit);
}

function submitTeamAnswer(answerIndex) {
  if (teamAnswered) return;
  teamAnswered = true;

  // Highlight selected
  const buttons = document.querySelectorAll('#tOptionsGrid .option-btn');
  buttons.forEach((btn, i) => {
    btn.classList.add('disabled');
    if (i === answerIndex) {
      btn.classList.add('selected');
    }
  });

  socket.emit('submit-answer', {
    questionId: currentQuestionData.id,
    answerIndex
  });

  document.getElementById('answerStatusText').textContent = 'Answer submitted! Waiting for other teams...';
  document.getElementById('answerStatusText').style.color = 'white';
}

function revealTeamAnswer(correctAnswer, explanation, reference, scoreboard) {
  // Show correct/wrong on buttons
  const buttons = document.querySelectorAll('#tOptionsGrid .option-btn');
  buttons.forEach((btn, i) => {
    btn.classList.add('disabled');
    if (i === correctAnswer) {
      btn.classList.add('correct');
    }
    if (btn.classList.contains('selected') && i !== correctAnswer) {
      btn.classList.add('wrong');
    }
  });

  // Show explanation
  document.getElementById('tExplanationText').textContent = explanation;
  document.getElementById('tExplanationRef').textContent = `Reference: ${reference}`;
  document.getElementById('tExplanationBox').classList.add('show');

  // Show mini scoreboard
  renderMiniScoreboard(scoreboard);

  // Update live scores
  renderLiveScores(scoreboard);

  // Update progress
  document.getElementById('tProgressBar').style.width = `${(currentQuestionNum / totalQuestions) * 100}%`;
}

function renderMiniScoreboard(scoreboard) {
  const tbody = document.getElementById('miniScoreBody');
  tbody.innerHTML = '';

  scoreboard.forEach((team, index) => {
    const rank = index + 1;
    const rankEmojis = ['🥇', '🥈', '🥉'];
    const rankDisplay = rank <= 3 ? rankEmojis[rank - 1] : `#${rank}`;

    const lastAnswer = team.lastAnswer;
    let answerStatus = '---';
    if (lastAnswer) {
      if (lastAnswer.answerIndex === -1) {
        answerStatus = 'No answer';
      } else if (lastAnswer.isCorrect) {
        answerStatus = `+${lastAnswer.points}`;
      } else {
        answerStatus = 'Wrong';
      }
    }

    const isMyTeam = team.teamId === myTeamId;
    const tr = document.createElement('tr');
    tr.className = `rank-${rank}`;
    if (isMyTeam) tr.style.fontWeight = '800';

    tr.innerHTML = `
      <td><span class="rank-badge">${rankDisplay}</span></td>
      <td>${team.teamName}${isMyTeam ? ' (You)' : ''}</td>
      <td style="font-weight: 800; color: var(--primary);">${team.score}</td>
      <td style="color: ${lastAnswer && lastAnswer.isCorrect ? 'var(--success)' : lastAnswer && lastAnswer.answerIndex !== -1 ? 'var(--danger)' : 'var(--text-light)'};">${answerStatus}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('miniScoreboard').classList.remove('hidden');
}

function renderLiveScores(scoreboard) {
  const container = document.getElementById('liveScores');
  container.innerHTML = '';

  const maxScore = Math.max(...scoreboard.map(t => t.score));

  scoreboard.forEach(team => {
    const chip = document.createElement('div');
    chip.className = 'live-score-chip';
    if (team.score === maxScore && maxScore > 0) {
      chip.classList.add('leading');
    }
    const isMe = team.teamId === myTeamId ? ' *' : '';
    chip.textContent = `${team.teamName}: ${team.score}${isMe}`;
    container.appendChild(chip);
  });
}

// ============ TEAM TIMER ============

function startTeamTimer(seconds) {
  teamTimeLeft = seconds;
  const display = document.getElementById('tTimerDisplay');
  display.textContent = teamTimeLeft;
  display.className = 'quiz-timer';

  clearInterval(teamTimerInterval);
  teamTimerInterval = setInterval(() => {
    teamTimeLeft--;
    display.textContent = teamTimeLeft;

    if (teamTimeLeft <= 5) {
      display.className = 'quiz-timer danger';
    } else if (teamTimeLeft <= 10) {
      display.className = 'quiz-timer warning';
    }

    if (teamTimeLeft <= 0) {
      clearInterval(teamTimerInterval);
      if (!teamAnswered) {
        // Auto-submit no answer
        teamAnswered = true;
        document.querySelectorAll('#tOptionsGrid .option-btn').forEach(btn => btn.classList.add('disabled'));
        document.getElementById('answerStatusText').textContent = "Time's up! No answer submitted.";
        document.getElementById('answerStatusText').style.color = '#d63031';
      }
    }
  }, 1000);
}

// ============ FINAL RESULTS ============

function showFinalResults(scoreboard, tips, total) {
  showSection('finalResultsSection');

  // Winner announcement
  if (scoreboard.length > 0) {
    const winner = scoreboard[0];
    document.getElementById('winnerAnnouncement').textContent =
      `${winner.teamName} wins with ${winner.score} points!`;

    // Confetti for the winner
    launchConfetti();
  }

  // Final scoreboard
  const tbody = document.getElementById('finalScoreBody');
  tbody.innerHTML = '';

  scoreboard.forEach((team, index) => {
    const rank = index + 1;
    const rankEmojis = ['🥇', '🥈', '🥉'];
    const rankDisplay = rank <= 3 ? rankEmojis[rank - 1] : `#${rank}`;

    const isMyTeam = team.teamId === myTeamId;
    const tr = document.createElement('tr');
    tr.className = `rank-${rank}`;
    if (isMyTeam) tr.style.fontWeight = '800';

    const percentage = total > 0 ? Math.round((team.correctAnswers / total) * 100) : 0;

    tr.innerHTML = `
      <td><span class="rank-badge">${rankDisplay}</span></td>
      <td>${team.teamName}${isMyTeam ? ' (You)' : ''}</td>
      <td style="font-size: 0.85rem;">${team.players.join(', ')}</td>
      <td>${team.correctAnswers}/${total} (${percentage}%)</td>
      <td style="font-weight: 800; color: var(--primary); font-size: 1.2rem;">${team.score}</td>
    `;
    tbody.appendChild(tr);
  });

  // Tips
  const tipsList = document.getElementById('finalTipsList');
  tipsList.innerHTML = '';
  tips.forEach(tip => {
    const li = document.createElement('li');
    li.textContent = tip;
    tipsList.appendChild(li);
  });
}

function playAgain() {
  if (isHost) {
    // Go back to waiting room
    showSection('waitingSection');
  } else {
    showSection('waitingSection');
  }
}

// ============ UTILITIES ============

function showSection(sectionId) {
  ['setupSection', 'waitingSection', 'teamQuizSection', 'finalResultsSection'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById(sectionId).classList.remove('hidden');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function launchConfetti() {
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f43'];

  for (let i = 0; i < 100; i++) {
    setTimeout(() => {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
      piece.style.width = (Math.random() * 10 + 5) + 'px';
      piece.style.height = (Math.random() * 10 + 5) + 'px';
      piece.style.animationDuration = (Math.random() * 2 + 2) + 's';
      document.body.appendChild(piece);

      setTimeout(() => piece.remove(), 4500);
    }, i * 25);
  }
}

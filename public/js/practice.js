// ============ STATE ============
let currentCategory = null;
let currentDifficulty = 'all';
let selectedCount = 20;
let questions = [];
let currentIndex = 0;
let score = 0;
let correctCount = 0;
let wrongCount = 0;
let streak = 0;
let bestStreak = 0;
let timerEnabled = true;
let timerInterval = null;
let timeLeft = 20;
let answered = false;
let categories = [];
let missedQuestions = [];
let newQuestionsThisRound = 0;
let isDailyChallenge = false;

// ============ PERSISTENCE (localStorage) ============
const STORAGE_KEY = 'bible_quiz_progress';

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch { return {}; }
}

function saveProgress(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function markQuestionSeen(questionId, wasCorrect) {
  const progress = loadProgress();
  if (!progress.seen) progress.seen = {};
  const prev = progress.seen[questionId] || { times: 0, correct: 0 };
  progress.seen[questionId] = {
    times: prev.times + 1,
    correct: prev.correct + (wasCorrect ? 1 : 0),
    lastSeen: Date.now()
  };

  // Update streak
  if (!progress.dailyStreak) progress.dailyStreak = { count: 0, lastDate: '' };
  const today = new Date().toISOString().slice(0, 10);
  if (progress.dailyStreak.lastDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (progress.dailyStreak.lastDate === yesterday) {
      progress.dailyStreak.count++;
    } else if (progress.dailyStreak.lastDate !== today) {
      progress.dailyStreak.count = 1;
    }
    progress.dailyStreak.lastDate = today;
  }

  // Track sessions
  if (!progress.totalSessions) progress.totalSessions = 0;
  if (!progress.totalCorrect) progress.totalCorrect = 0;
  if (!progress.totalAnswered) progress.totalAnswered = 0;
  progress.totalAnswered++;
  if (wasCorrect) progress.totalCorrect++;

  // High score
  if (!progress.highScore) progress.highScore = 0;

  saveProgress(progress);
}

function getSeenIds() {
  const progress = loadProgress();
  return progress.seen ? Object.keys(progress.seen).map(Number) : [];
}

function getMasteredCount() {
  const progress = loadProgress();
  if (!progress.seen) return 0;
  // "Mastered" = answered correctly at least twice
  return Object.values(progress.seen).filter(s => s.correct >= 2).length;
}

function incrementSessions() {
  const progress = loadProgress();
  progress.totalSessions = (progress.totalSessions || 0) + 1;
  saveProgress(progress);
}

function updateHighScore(newScore) {
  const progress = loadProgress();
  if (newScore > (progress.highScore || 0)) {
    progress.highScore = newScore;
    saveProgress(progress);
    return true;
  }
  return false;
}

function getDailyStreak() {
  const progress = loadProgress();
  if (!progress.dailyStreak) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (progress.dailyStreak.lastDate === today || progress.dailyStreak.lastDate === yesterday) {
    return progress.dailyStreak.count;
  }
  return 0;
}

function getDailyChallengeStatus() {
  const progress = loadProgress();
  const today = new Date().toISOString().slice(0, 10);
  return progress.dailyChallengeDate === today;
}

function setDailyChallengeComplete() {
  const progress = loadProgress();
  progress.dailyChallengeDate = new Date().toISOString().slice(0, 10);
  saveProgress(progress);
}

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', () => {
  loadCategories();

  const params = new URLSearchParams(window.location.search);
  const cat = params.get('category');
  if (cat) {
    // Wait for categories to load then select
    const waitForCats = setInterval(() => {
      if (categories.length > 0) {
        clearInterval(waitForCats);
        selectCategory(cat);
      }
    }, 100);
  }

  renderProgressCard();
  renderDailyChallenge();
});

async function loadCategories() {
  const res = await fetch('/api/categories');
  categories = await res.json();
  renderCategories();
}

function renderCategories() {
  const grid = document.getElementById('categoryGrid');
  grid.innerHTML = '';
  const progress = loadProgress();
  const seen = progress.seen || {};

  categories.forEach(cat => {
    const card = document.createElement('div');
    card.className = 'category-card';
    card.style.borderColor = cat.color;
    card.onclick = () => selectCategory(cat.id);

    // Count how many questions user has seen in this category
    const catSeen = Object.entries(seen).filter(([id, data]) => {
      // We'll show total seen; can't filter by category without loading all questions
      return true;
    }).length;

    card.innerHTML = `
      <div class="cat-icon">${cat.icon}</div>
      <h3>${cat.name}</h3>
      <div class="cat-ref">${cat.reference}</div>
      <div class="cat-desc">${cat.description}</div>
    `;
    grid.appendChild(card);
  });
}

function renderProgressCard() {
  const progress = loadProgress();
  const card = document.getElementById('progressCard');

  if (!progress.totalAnswered || progress.totalAnswered === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  const stats = document.getElementById('progressStats');
  const overallAccuracy = progress.totalAnswered > 0
    ? Math.round((progress.totalCorrect / progress.totalAnswered) * 100)
    : 0;
  const mastered = getMasteredCount();
  const dailyStreak = getDailyStreak();

  stats.innerHTML = `
    <div class="stat-item">
      <div class="stat-value">${progress.totalSessions || 0}</div>
      <div class="stat-label">Sessions Played</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${overallAccuracy}%</div>
      <div class="stat-label">Overall Accuracy</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${mastered}</div>
      <div class="stat-label">Questions Mastered</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${Object.keys(progress.seen || {}).length}</div>
      <div class="stat-label">Questions Seen</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${progress.highScore || 0}</div>
      <div class="stat-label">High Score</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${dailyStreak > 0 ? dailyStreak + ' days' : '0'}</div>
      <div class="stat-label">Daily Streak</div>
    </div>
  `;
}

function renderDailyChallenge() {
  const completed = getDailyChallengeStatus();
  const streak = getDailyStreak();
  const badge = document.getElementById('dailyStreakBadge');

  if (completed) {
    document.getElementById('dailyChallengeDesc').textContent = "You already completed today's challenge! Come back tomorrow for a new one.";
    document.querySelector('#dailyChallengeCard .btn').textContent = 'Completed!';
    document.querySelector('#dailyChallengeCard .btn').disabled = true;
    document.querySelector('#dailyChallengeCard .btn').style.opacity = '0.5';
  }

  if (streak > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent = `${streak} day streak!`;
  }
}

// ============ CATEGORY SELECTION ============
function selectCategory(catId) {
  currentCategory = catId;
  isDailyChallenge = false;
  const cat = categories.find(c => c.id === catId);

  if (cat) {
    document.getElementById('selectedCategoryTitle').textContent = `${cat.icon} ${cat.name}`;
    document.getElementById('selectedCategoryRef').textContent = cat.reference;
  }

  // Fetch to get count
  fetchAvailableCount();
  showSection('settingsSection');
}

function startMixedQuiz() {
  currentCategory = 'mix';
  isDailyChallenge = false;
  document.getElementById('selectedCategoryTitle').textContent = 'Mixed Questions';
  document.getElementById('selectedCategoryRef').textContent = 'Questions from all women of the Bible!';
  fetchAvailableCount();
  showSection('settingsSection');
}

async function fetchAvailableCount() {
  const url = currentCategory === 'mix'
    ? '/api/questions/mix/random?count=9999'
    : `/api/questions/${currentCategory}?difficulty=${currentDifficulty}`;
  const res = await fetch(url);
  const data = await res.json();
  const total = data.length;
  const seen = getSeenIds();
  const fresh = data.filter(q => !seen.includes(q.id)).length;

  document.getElementById('availableCount').textContent =
    `${total} questions available (${fresh} new, ${total - fresh} reviewed)`;
}

function selectCount(count, btn) {
  selectedCount = count;
  document.querySelectorAll('#countSelector .diff-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function selectDifficulty(diff, btn) {
  currentDifficulty = diff;
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  fetchAvailableCount();
}

// ============ DAILY CHALLENGE ============
async function startDailyChallenge() {
  if (getDailyChallengeStatus()) return;

  isDailyChallenge = true;
  currentCategory = 'mix';
  currentDifficulty = 'all';
  timerEnabled = true;

  const res = await fetch('/api/questions/mix/random?count=9999');
  let allQ = await res.json();

  // Use today's date as a seed for consistent daily questions
  const today = new Date().toISOString().slice(0, 10);
  allQ = seededShuffle(allQ, hashString(today));
  questions = allQ.slice(0, 20);

  if (questions.length === 0) {
    alert('No questions available!');
    return;
  }

  currentIndex = 0;
  score = 0;
  correctCount = 0;
  wrongCount = 0;
  streak = 0;
  bestStreak = 0;
  missedQuestions = [];
  newQuestionsThisRound = 0;
  answered = false;
  incrementSessions();

  showSection('quizSection');
  renderQuestion();
}

// ============ QUIZ LOGIC ============
async function startQuiz() {
  timerEnabled = document.getElementById('timerToggle').checked;
  const freshOnly = document.getElementById('freshOnlyToggle').checked;

  let url;
  if (currentCategory === 'mix') {
    url = '/api/questions/mix/random?count=9999';
  } else {
    url = `/api/questions/${currentCategory}?difficulty=${currentDifficulty}`;
  }

  const res = await fetch(url);
  let allQ = await res.json();

  if (allQ.length === 0) {
    alert('No questions found for this selection. Try a different difficulty!');
    return;
  }

  // Filter for fresh only if requested
  if (freshOnly) {
    const seen = getSeenIds();
    const freshQ = allQ.filter(q => !seen.includes(q.id));
    if (freshQ.length > 0) {
      allQ = freshQ;
    }
    // If all seen, use all questions anyway (re-shuffle)
  }

  // Prioritize unseen questions: put unseen first, then seen (sorted by least-seen)
  const seen = getSeenIds();
  const progress = loadProgress();
  const seenData = progress.seen || {};

  allQ.sort((a, b) => {
    const aSeen = seen.includes(a.id);
    const bSeen = seen.includes(b.id);
    if (!aSeen && bSeen) return -1;
    if (aSeen && !bSeen) return 1;
    // Both seen: prioritize ones with lower correct rate
    if (aSeen && bSeen) {
      const aData = seenData[a.id] || { correct: 0, times: 1 };
      const bData = seenData[b.id] || { correct: 0, times: 1 };
      const aRate = aData.correct / aData.times;
      const bRate = bData.correct / bData.times;
      return aRate - bRate; // Lower rate = prioritize
    }
    return 0;
  });

  // Add some randomness within groups
  const unseen = allQ.filter(q => !seen.includes(q.id));
  const seenQ = allQ.filter(q => seen.includes(q.id));
  shuffleArray(unseen);
  shuffleArray(seenQ);
  allQ = [...unseen, ...seenQ];

  // Apply count limit
  const limit = selectedCount === 0 ? allQ.length : Math.min(selectedCount, allQ.length);
  questions = allQ.slice(0, limit);

  // Shuffle final set so unseen aren't always first during the quiz
  shuffleArray(questions);

  // Reset state
  currentIndex = 0;
  score = 0;
  correctCount = 0;
  wrongCount = 0;
  streak = 0;
  bestStreak = 0;
  missedQuestions = [];
  newQuestionsThisRound = 0;
  answered = false;
  incrementSessions();

  showSection('quizSection');
  renderQuestion();
}

function renderQuestion() {
  const q = questions[currentIndex];
  answered = false;

  // Update header
  document.getElementById('questionCount').textContent = `${currentIndex + 1}/${questions.length}`;
  document.getElementById('progressBar').style.width = `${((currentIndex) / questions.length) * 100}%`;
  document.getElementById('scoreDisplay').textContent = `Score: ${score}`;

  // Category info
  const catInfo = categories.find(c => c.id === q.category);
  const catName = catInfo ? catInfo.name : q.category;
  const catIcon = catInfo ? catInfo.icon : '';

  // Is this a new question?
  const seen = getSeenIds();
  const isNew = !seen.includes(q.id);

  const meta = document.getElementById('questionMeta');
  meta.innerHTML = `
    <span class="badge badge-category">${catIcon} ${catName}</span>
    <span class="badge badge-${q.difficulty}">${q.difficulty.charAt(0).toUpperCase() + q.difficulty.slice(1)}</span>
    ${isNew ? '<span class="badge" style="background: #e8f8f5; color: #00b894;">NEW</span>' : ''}
  `;

  document.getElementById('questionText').textContent = q.question;

  // Options
  const grid = document.getElementById('optionsGrid');
  grid.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

  q.options.forEach((option, index) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `
      <span class="option-letter">${letters[index]}</span>
      <span>${option}</span>
    `;
    btn.onclick = () => handleAnswer(index);
    grid.appendChild(btn);
  });

  // Hide explanation and next button
  document.getElementById('explanationBox').classList.remove('show');
  document.getElementById('nextBtnContainer').style.display = 'none';

  // Streak display
  if (streak >= 2) {
    document.getElementById('streakDisplay').classList.remove('hidden');
    document.getElementById('streakBadge').textContent = `${streak} Streak!`;
  } else {
    document.getElementById('streakDisplay').classList.add('hidden');
  }

  // Timer
  if (timerEnabled) {
    document.getElementById('timerDisplay').classList.remove('hidden');
    startTimer();
  } else {
    document.getElementById('timerDisplay').classList.add('hidden');
  }
}

function handleAnswer(selectedIndex) {
  if (answered) return;
  answered = true;

  clearInterval(timerInterval);

  const q = questions[currentIndex];
  const isCorrect = selectedIndex === q.correct;
  const buttons = document.querySelectorAll('#optionsGrid .option-btn');

  // Check if new question
  const seen = getSeenIds();
  if (!seen.includes(q.id)) newQuestionsThisRound++;

  // Track in localStorage
  markQuestionSeen(q.id, isCorrect);

  // Disable all buttons
  buttons.forEach((btn, i) => {
    btn.classList.add('disabled');
    if (i === q.correct) {
      btn.classList.add('correct');
    }
    if (i === selectedIndex && !isCorrect) {
      btn.classList.add('wrong');
    }
  });

  if (isCorrect) {
    const timeBonus = timerEnabled ? Math.max(0, timeLeft * 5) : 0;
    const diffBonus = q.difficulty === 'hard' ? 30 : q.difficulty === 'medium' ? 15 : 0;
    const streakBonus = streak >= 2 ? streak * 10 : 0;
    const points = 100 + timeBonus + diffBonus + streakBonus;
    score += points;
    correctCount++;
    streak++;
    if (streak > bestStreak) bestStreak = streak;

    if (streak >= 2) {
      document.getElementById('streakDisplay').classList.remove('hidden');
      document.getElementById('streakBadge').textContent = `${streak} Streak! (+${streakBonus} bonus)`;
    }

    document.getElementById('explanationHeader').textContent = getCorrectReaction();
  } else {
    wrongCount++;
    streak = 0;
    missedQuestions.push({ question: q, selectedIndex });
    document.getElementById('streakDisplay').classList.add('hidden');
    document.getElementById('explanationHeader').textContent = selectedIndex === -1 ? "Time's up!" : "Not quite!";
  }

  document.getElementById('scoreDisplay').textContent = `Score: ${score}`;

  // Show explanation
  document.getElementById('explanationText').textContent = q.explanation;
  document.getElementById('explanationRef').textContent = `Reference: ${q.reference}`;
  document.getElementById('explanationBox').classList.add('show');

  // Show next button
  document.getElementById('nextBtnContainer').style.display = 'block';

  // Auto-scroll to explanation on mobile
  setTimeout(() => {
    document.getElementById('explanationBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 300);
}

function getCorrectReaction() {
  const reactions = [
    'Correct! Well done!',
    'You got it!',
    'Excellent! Keep going!',
    'That\'s right!',
    'Amazing! You really know this!',
    'Spot on!',
    'Wonderful!',
    'Yes! Nailed it!',
    'Great answer!',
    'You\'re on fire!'
  ];
  return reactions[Math.floor(Math.random() * reactions.length)];
}

function nextQuestion() {
  currentIndex++;
  if (currentIndex < questions.length) {
    renderQuestion();
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    showResults();
  }
}

// ============ TIMER ============
function startTimer() {
  timeLeft = 20;
  const display = document.getElementById('timerDisplay');
  display.textContent = timeLeft;
  display.className = 'quiz-timer';

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeLeft--;
    display.textContent = timeLeft;

    if (timeLeft <= 5) {
      display.className = 'quiz-timer danger';
    } else if (timeLeft <= 10) {
      display.className = 'quiz-timer warning';
    }

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      if (!answered) {
        handleAnswer(-1);
      }
    }
  }, 1000);
}

// ============ RESULTS ============
function showResults() {
  showSection('resultsSection');

  const percentage = Math.round((correctCount / questions.length) * 100);
  const isNewHighScore = updateHighScore(score);

  if (isDailyChallenge) {
    setDailyChallengeComplete();
  }

  document.getElementById('progressBar').style.width = '100%';

  let emoji, title;
  if (percentage === 100) {
    emoji = '👑';
    title = 'PERFECT SCORE! You are a Bible champion!';
  } else if (percentage >= 90) {
    emoji = '🏆';
    title = isNewHighScore ? 'NEW HIGH SCORE! Outstanding!' : 'Outstanding! You really know your Bible!';
  } else if (percentage >= 70) {
    emoji = '🌟';
    title = 'Great job! Keep studying!';
  } else if (percentage >= 50) {
    emoji = '💪';
    title = 'Good effort! Practice makes perfect!';
  } else {
    emoji = '📖';
    title = 'Keep reading! You\'ll get better!';
  }

  if (isDailyChallenge) {
    title = `Daily Challenge Complete! ${title}`;
  }

  document.getElementById('resultEmoji').textContent = emoji;
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('finalScore').textContent = score;
  document.getElementById('correctCount').textContent = correctCount;
  document.getElementById('wrongCount').textContent = wrongCount;
  document.getElementById('accuracy').textContent = percentage + '%';
  document.getElementById('bestStreak').textContent = bestStreak;
  document.getElementById('newQuestions').textContent = newQuestionsThisRound;
  document.getElementById('totalMastered').textContent = getMasteredCount();

  // Weak areas analysis
  renderWeakAreas();

  // Generate tips
  const tips = generatePracticeTips();
  const tipsList = document.getElementById('tipsList');
  tipsList.innerHTML = '';
  tips.forEach(tip => {
    const li = document.createElement('li');
    li.textContent = tip;
    tipsList.appendChild(li);
  });

  // Confetti for good scores
  if (percentage >= 70) {
    launchConfetti();
  }
  if (percentage === 100) {
    setTimeout(() => launchConfetti(), 1500);
  }
}

function renderWeakAreas() {
  const box = document.getElementById('weakAreasBox');
  const list = document.getElementById('weakAreasList');

  if (missedQuestions.length === 0) {
    box.style.display = 'none';
    return;
  }

  box.style.display = 'block';
  list.innerHTML = '';

  // Group missed by category
  const missedByCat = {};
  missedQuestions.forEach(({ question }) => {
    if (!missedByCat[question.category]) missedByCat[question.category] = 0;
    missedByCat[question.category]++;
  });

  Object.entries(missedByCat).forEach(([cat, count]) => {
    const catInfo = categories.find(c => c.id === cat);
    const name = catInfo ? catInfo.name : cat;
    const li = document.createElement('li');
    li.textContent = `${name}: ${count} question${count > 1 ? 's' : ''} missed — review ${catInfo ? catInfo.reference : ''} carefully!`;
    list.appendChild(li);
  });
}

function reviewMissed() {
  if (missedQuestions.length === 0) {
    alert('You didn\'t miss any questions! Amazing!');
    return;
  }

  showSection('reviewSection');
  const container = document.getElementById('reviewCards');
  container.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];

  missedQuestions.forEach(({ question: q, selectedIndex }, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '15px';

    const catInfo = categories.find(c => c.id === q.category);
    const catName = catInfo ? `${catInfo.icon} ${catInfo.name}` : q.category;

    let optionsHTML = q.options.map((opt, idx) => {
      let cls = '';
      if (idx === q.correct) cls = 'style="color: var(--success); font-weight: 700;"';
      if (idx === selectedIndex && idx !== q.correct) cls = 'style="color: var(--danger); text-decoration: line-through;"';
      return `<div ${cls}>${letters[idx]}. ${opt} ${idx === q.correct ? ' (Correct Answer)' : ''}</div>`;
    }).join('');

    card.innerHTML = `
      <div class="question-meta" style="margin-bottom: 10px;">
        <span class="badge badge-category">${catName}</span>
        <span class="badge badge-${q.difficulty}">${q.difficulty}</span>
        <span style="color: var(--text-light); font-size: 0.85rem;">#${i + 1}</span>
      </div>
      <div style="font-weight: 700; font-size: 1.1rem; margin-bottom: 12px;">${q.question}</div>
      <div style="margin-bottom: 12px; line-height: 1.8;">${optionsHTML}</div>
      <div class="explanation-box show">
        <h4>Explanation</h4>
        <p>${q.explanation}</p>
        <div class="ref">${q.reference}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

function generatePracticeTips() {
  const tips = [];
  const percentage = Math.round((correctCount / questions.length) * 100);

  if (missedQuestions.length > 0) {
    const hardMissed = missedQuestions.filter(m => m.question.difficulty === 'hard').length;
    if (hardMissed > 0) {
      tips.push(`You missed ${hardMissed} hard question${hardMissed > 1 ? 's' : ''}. Hard questions test small details — numbers, exact names, and specific NKJV wording.`);
    }
  }

  if (bestStreak >= 5) {
    tips.push(`Incredible streak of ${bestStreak}! Your focus really paid off.`);
  }

  if (percentage >= 90) {
    tips.push('You are conference-ready! Challenge yourself with "Hard" difficulty to sharpen your edge.');
    tips.push('Help your teammates learn — teaching is the best way to lock in knowledge!');
  } else if (percentage >= 70) {
    tips.push('Strong performance! Focus on the questions you missed — use the "Review Missed" button below.');
    tips.push('Try the "New questions only" option next time to see fresh material.');
  } else if (percentage >= 50) {
    tips.push('Good start! Read one chapter per day and discuss it with a friend or family member.');
    tips.push('Try retelling each story in your own words — it helps you remember the sequence of events.');
  } else {
    tips.push('Read the Bible chapters slowly. Start with the big picture, then focus on details.');
    tips.push('Try "Easy" difficulty first to build confidence, then work your way up.');
    tips.push('Ask someone to quiz you out loud — hearing the questions helps you remember!');
  }

  const dailyStreak = getDailyStreak();
  if (dailyStreak >= 3) {
    tips.push(`Amazing — ${dailyStreak} days in a row! Consistency beats cramming every time.`);
  } else {
    tips.push('Practice every day, even just 10 questions. Consistency is the key to winning at conference level!');
  }

  return tips;
}

// ============ CONFETTI ============
function launchConfetti() {
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f43'];
  for (let i = 0; i < 80; i++) {
    setTimeout(() => {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
      piece.style.width = (Math.random() * 8 + 5) + 'px';
      piece.style.height = (Math.random() * 8 + 5) + 'px';
      piece.style.animationDuration = (Math.random() * 2 + 2) + 's';
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 4000);
    }, i * 30);
  }
}

// ============ HELPERS ============
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function seededShuffle(array, seed) {
  const arr = [...array];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 16807 + 0) % 2147483647;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// ============ NAVIGATION ============
function showSection(sectionId) {
  ['categorySection', 'settingsSection', 'quizSection', 'resultsSection', 'reviewSection'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById(sectionId).classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function restartQuiz() {
  startQuiz();
}

function changeCategoryFromResults() {
  currentCategory = null;
  renderProgressCard();
  renderDailyChallenge();
  showSection('categorySection');
  window.history.replaceState({}, '', 'practice.html');
}

const canvas = document.getElementById('factoryCanvas');
const ctx = canvas.getContext('2d');

// --- Размеры ---
function resize() {
  canvas.width = Math.min(1200, window.innerWidth - 20);
  canvas.height = Math.min(650, window.innerHeight - 20);
}
window.addEventListener('resize', resize);
resize();

// --- Основные координаты ---
const groundY = canvas.height * 0.72;        // уровень пола
const conveyorY = groundY - 30;              // верх ленты конвейера
const pickX = 240;                           // позиция захвата (над левым конвейером)
const placeX = canvas.width - 180;           // позиция установки (над правым)
const pickY = conveyorY - 40;
const placeY = conveyorY - 40;

// --- Состояния руки ---
const ARM_STATE = {
  MOVE_TO_PICK: 'moveToPick',
  DESCEND: 'descend',
  GRASP: 'grasp',
  LIFT: 'lift',
  MOVE_TO_PLACE: 'moveToPlace',
  DESCEND_PLACE: 'descendPlace',
  RELEASE: 'release',
  RETURN: 'return'
};

// --- Параметры робота ---
const robot = {
  baseX: canvas.width / 2,
  baseY: groundY,
  shoulderLen: 90,
  elbowLen: 75,
  wristLen: 30,
  shoulderAngle: 0,
  elbowAngle: 0,
  targetShoulder: 0,
  targetElbow: 0,
  gripperOpen: 28,
  targetGripperOpen: 28,
  state: ARM_STATE.MOVE_TO_PICK,
  progress: 0,
  speed: 0.018,
  partHeld: null,
  // Для анимации покачивания
  shakeOffset: 0,
  shakeTimer: 0,
};

// --- Частицы (искры) ---
let particles = [];

// --- Детали ---
class Part {
  constructor(x, y, w = 44, h = 32) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.active = true;
    this.alpha = 1;
  }
}

let leftParts = [];
let rightParts = [];
let spawnTimer = 0;
const SPAWN_DELAY = 100;
let partsMoved = 0;  // счётчик перенесённых деталей

// Первая деталь
leftParts.push(new Part(40, pickY));

// --- Вспомогательные функции ---
function lerp(a,b,t) { return a + (b-a)*t; }
function lerpAngle(a,b,t) {
  let d = b-a;
  while(d>Math.PI) d-=Math.PI*2;
  while(d<-Math.PI) d+=Math.PI*2;
  return a+d*t;
}
function dist(x1,y1,x2,y2) { return Math.hypot(x2-x1, y2-y1); }

// Прямая кинематика: возвращает точку схвата
function getGripperPos() {
  const sx = robot.baseX;
  const sy = robot.baseY;
  const ex = sx + Math.cos(robot.shoulderAngle) * robot.shoulderLen;
  const ey = sy - Math.sin(robot.shoulderAngle) * robot.shoulderLen;
  const wristAngle = robot.shoulderAngle + robot.elbowAngle;
  const wx = ex + Math.cos(wristAngle) * robot.elbowLen;
  const wy = ey - Math.sin(wristAngle) * robot.elbowLen;
  const tx = wx + Math.cos(wristAngle) * robot.wristLen;
  const ty = wy - Math.sin(wristAngle) * robot.wristLen;
  return { sx, sy, ex, ey, wx, wy, tx, ty, wristAngle };
}

// Обратная кинематика (приближённая для двух звеньев + wrist)
function solveIK(targetX, targetY) {
  const dx = targetX - robot.baseX;
  const dy = -(targetY - robot.baseY); // переворот Y
  const reach = Math.sqrt(dx*dx + dy*dy);
  const L1 = robot.shoulderLen;
  const L2 = robot.elbowLen + robot.wristLen;
  if (reach > L1+L2-10) return false;
  const cosElbow = (reach*reach - L1*L1 - L2*L2) / (2*L1*L2);
  if (cosElbow < -1 || cosElbow > 1) return false;
  const elbow = Math.acos(cosElbow);
  const shoulder = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(elbow), L1 + L2 * Math.cos(elbow));
  robot.targetShoulder = shoulder;
  robot.targetElbow = elbow;
  return true;
}

// --- Отрисовка фона (плитка, стены, разметка) ---
function drawBackground() {
  // Небо / стена завода
  const wallGrad = ctx.createLinearGradient(0, 0, 0, groundY);
  wallGrad.addColorStop(0, '#1e272e');
  wallGrad.addColorStop(0.6, '#2f3640');
  wallGrad.addColorStop(1, '#353b48');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, canvas.width, groundY);

  // Пол
  const floorGrad = ctx.createLinearGradient(0, groundY, 0, canvas.height);
  floorGrad.addColorStop(0, '#3d424a');
  floorGrad.addColorStop(1, '#2a2e35');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);

  // Плитка на полу
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, groundY);
    ctx.lineTo(x, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.stroke();
  }
  for (let y = groundY; y < canvas.height; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.stroke();
  }

  // Предупреждающие полосы (жёлто-чёрные)
  drawWarningStripes(50, groundY - 5, canvas.width - 100, 6);

  // Конвейеры
  drawConveyor(80, conveyorY, 300);        // левый
  drawConveyor(canvas.width - 380, conveyorY, 300); // правый

  // Надписи зон
  ctx.font = 'bold 13px "Segoe UI", monospace';
  ctx.fillStyle = '#f1c40f';
  ctx.fillText('ПОДАЧА', 180, conveyorY - 45);
  ctx.fillText('ПРИЁМ', canvas.width - 290, conveyorY - 45);
}

function drawWarningStripes(x, y, w, h) {
  const count = Math.floor(w / 20);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#f1c40f' : '#222';
    ctx.fillRect(x + i * 20, y, 20, h);
  }
}

let beltOffset = 0;
function drawConveyor(x, y, width) {
  // Корпус
  ctx.fillStyle = '#4a4f57';
  ctx.fillRect(x, y, width, 16);
  // Борта
  ctx.fillStyle = '#5a5f67';
  ctx.fillRect(x, y-6, width, 6);
  ctx.fillRect(x, y+16, width, 6);
  // Ролики
  for (let i = 0; i < 8; i++) {
    const rx = x + 20 + i * 40;
    ctx.beginPath();
    ctx.arc(rx, y+8, 9, 0, Math.PI*2);
    ctx.fillStyle = '#7f8c8d';
    ctx.fill();
    ctx.strokeStyle = '#2c3e50';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Лента с движущимися полосами
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y+4, width, 8);
  ctx.clip();
  const stripeWidth = 25;
  const offset = beltOffset % (stripeWidth*2);
  for (let i = -stripeWidth*2; i < width + stripeWidth*2; i += stripeWidth*2) {
    ctx.fillStyle = '#5d6d7e';
    ctx.fillRect(x + i + offset, y+4, stripeWidth, 8);
    ctx.fillStyle = '#3e4a55';
    ctx.fillRect(x + i + offset + stripeWidth, y+4, stripeWidth, 8);
  }
  ctx.restore();
  // Блик на ленте
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y+4, width, 2);
}

// --- Отрисовка деталей ---
function drawPart(p) {
  if (!p.active && p !== robot.partHeld) return;
  ctx.save();
  ctx.globalAlpha = p.alpha;
  // Тень
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  // Корпус
  const grad = ctx.createLinearGradient(p.x - p.w/2, p.y - p.h/2, p.x + p.w/2, p.y + p.h/2);
  grad.addColorStop(0, '#bdc3c7');
  grad.addColorStop(0.5, '#ecf0f1');
  grad.addColorStop(1, '#95a5a6');
  ctx.fillStyle = grad;
  ctx.fillRect(p.x - p.w/2, p.y - p.h/2, p.w, p.h);
  // Фаска
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(p.x - p.w/2 + 4, p.y - p.h/2 + 2, p.w - 8, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(p.x - p.w/2 + 4, p.y + p.h/2 - 5, p.w - 8, 3);
  // Обводка
  ctx.strokeStyle = '#7f8c8d';
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x - p.w/2, p.y - p.h/2, p.w, p.h);
  ctx.restore();
}

// --- Отрисовка руки робота ---
function drawRobotArm() {
  const { sx, sy, ex, ey, wx, wy, tx, ty, wristAngle } = getGripperPos();

  // Тень от руки на полу
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(sx, groundY + 15, 70, 15, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();

  // База
  drawBase(sx, sy);

  // Плечо
  drawSegment(sx, sy, ex, ey, 18, '#d35400', '#e67e22');
  // Сустав плеча
  drawJoint(sx, sy, 16);
  // Локоть
  drawSegment(ex, ey, wx, wy, 14, '#2980b9', '#3498db');
  drawJoint(ex, ey, 12);
  // Запястье
  drawSegment(wx, wy, tx, ty, 10, '#27ae60', '#2ecc71');

  // Гидравлические цилиндры (декор)
  drawHydraulicCylinder(sx, sy, ex, ey, -0.3);
  drawHydraulicCylinder(ex, ey, wx, wy, 0.2);

  // Захват
  drawGripper(wx, wy, wristAngle, tx, ty);

  // Индикатор на запястье
  ctx.beginPath();
  ctx.arc(wx, wy, 5, 0, Math.PI*2);
  ctx.fillStyle = robot.partHeld ? '#2ecc71' : '#e74c3c';
  ctx.fill();
  ctx.shadowBlur = 12;
  ctx.shadowColor = ctx.fillStyle;
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawBase(x, y) {
  // Платформа
  ctx.fillStyle = '#34495e';
  ctx.fillRect(x-35, y-8, 70, 18);
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(x-28, y-16, 56, 8);
  // Кнопка
  ctx.beginPath();
  ctx.arc(x, y-22, 7, 0, Math.PI*2);
  ctx.fillStyle = '#f1c40f';
  ctx.fill();
  ctx.shadowBlur = 8;
  ctx.shadowColor = '#f1c40f';
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawSegment(x1,y1,x2,y2, thickness, color1, color2) {
  const angle = Math.atan2(y2-y1, x2-x1);
  const len = dist(x1,y1,x2,y2);
  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(angle);
  // Градиент тела
  const grad = ctx.createLinearGradient(0, -thickness/2, 0, thickness/2);
  grad.addColorStop(0, color1);
  grad.addColorStop(0.5, color2);
  grad.addColorStop(1, color1);
  ctx.fillStyle = grad;
  ctx.fillRect(0, -thickness/2, len, thickness);
  // Кабели
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(8, -thickness/4);
  ctx.lineTo(len-8, -thickness/4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(8, thickness/4);
  ctx.lineTo(len-8, thickness/4);
  ctx.stroke();
  ctx.restore();
}

function drawJoint(x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI*2);
  const grad = ctx.createRadialGradient(x-3, y-3, radius*0.1, x, y, radius);
  grad.addColorStop(0, '#ecf0f1');
  grad.addColorStop(1, '#7f8c8d');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#2c3e50';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHydraulicCylinder(x1,y1,x2,y2, offset) {
  const angle = Math.atan2(y2-y1, x2-x1);
  const perpX = Math.cos(angle + Math.PI/2);
  const perpY = Math.sin(angle + Math.PI/2);
  const mx = (x1+x2)/2 + perpX * offset * 30;
  const my = (y1+y2)/2 + perpY * offset * 30;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(mx, my);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Поршень
  ctx.beginPath();
  ctx.arc(mx, my, 5, 0, Math.PI*2);
  ctx.fillStyle = '#999';
  ctx.fill();
}

function drawGripper(wx, wy, angle, tx, ty) {
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(angle);
  // Корпус схвата
  ctx.fillStyle = '#7f8c8d';
  ctx.fillRect(-12, -8, 24, 16);
  // Пальцы
  const open = robot.gripperOpen / 2;
  const fingerLen = 30;
  // Левая губка
  ctx.fillStyle = '#bdc3c7';
  ctx.fillRect(-open - 18, -14, 16, 28);
  ctx.strokeStyle = '#2c3e50';
  ctx.lineWidth = 1;
  ctx.strokeRect(-open - 18, -14, 16, 28);
  // Правая губка
  ctx.fillRect(open + 2, -14, 16, 28);
  ctx.strokeRect(open + 2, -14, 16, 28);
  // Кончики (резиновые вставки)
  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(-open - 16, -16, 12, 4);
  ctx.fillRect(open + 4, -16, 12, 4);
  ctx.restore();
}

// --- Частицы искр ---
function spawnSparks(x, y, count) {
  for (let i=0; i<count; i++) {
    particles.push({
      x, y,
      vx: (Math.random()-0.5)*4,
      vy: (Math.random()-0.5)*4 - 1,
      life: 1,
      decay: 0.02 + Math.random()*0.03,
      size: 1 + Math.random()*3,
      color: Math.random()<0.5 ? '#f1c40f' : '#e67e22'
    });
  }
}

function updateParticles() {
  for (let i=particles.length-1; i>=0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i,1);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowBlur = 6;
    ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

// --- Логика состояний ---
function updateRobot() {
  // Плавное движение углов и захвата
  robot.shoulderAngle = lerpAngle(robot.shoulderAngle, robot.targetShoulder, 0.1);
  robot.elbowAngle = lerpAngle(robot.elbowAngle, robot.targetElbow, 0.1);
  robot.gripperOpen = lerp(robot.gripperOpen, robot.targetGripperOpen, 0.2);

  // Лёгкое покачивание при переносе
  if (robot.partHeld && (robot.state === ARM_STATE.MOVE_TO_PLACE || robot.state === ARM_STATE.LIFT)) {
    robot.shakeTimer += 0.1;
    robot.shakeOffset = Math.sin(robot.shakeTimer) * 1.5;
    robot.targetShoulder += robot.shakeOffset * 0.01;
  } else {
    robot.shakeOffset = 0;
  }

  const tip = getGripperPos();

  switch (robot.state) {
    case ARM_STATE.MOVE_TO_PICK:
      solveIK(pickX, pickY);
      robot.targetGripperOpen = 28;
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        robot.state = ARM_STATE.DESCEND;
      }
      break;
    case ARM_STATE.DESCEND:
      solveIK(pickX, pickY + 20);
      robot.progress += robot.speed;
      if (robot.progress >= 0.5) {
        robot.progress = 0;
        robot.state = ARM_STATE.GRASP;
      }
      break;
    case ARM_STATE.GRASP:
      robot.targetGripperOpen = 6;
      robot.progress += robot.speed * 2;
      if (robot.progress >= 1) {
        // Захват детали
        const part = leftParts.find(p => p.active && dist(p.x, p.y, pickX, pickY) < 40);
        if (part) {
          robot.partHeld = part;
          part.active = false;
          spawnSparks(pickX, pickY+10, 15);
        }
        robot.progress = 0;
        robot.state = ARM_STATE.LIFT;
      }
      break;
    case ARM_STATE.LIFT:
      solveIK(pickX, pickY - 50);
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        robot.state = ARM_STATE.MOVE_TO_PLACE;
      }
      break;
    case ARM_STATE.MOVE_TO_PLACE:
      solveIK(placeX, placeY - 50);
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        robot.state = ARM_STATE.DESCEND_PLACE;
      }
      break;
    case ARM_STATE.DESCEND_PLACE:
      solveIK(placeX, placeY + 20);
      robot.progress += robot.speed;
      if (robot.progress >= 0.5) {
        robot.progress = 0;
        robot.state = ARM_STATE.RELEASE;
      }
      break;
    case ARM_STATE.RELEASE:
      robot.targetGripperOpen = 28;
      robot.progress += robot.speed * 2;
      if (robot.progress >= 1) {
        if (robot.partHeld) {
          robot.partHeld.x = placeX;
          robot.partHeld.y = placeY;
          robot.partHeld.active = true;
          rightParts.push(robot.partHeld);
          robot.partHeld = null;
          partsMoved++;
          spawnSparks(placeX, placeY+10, 15);
        }
        robot.progress = 0;
        robot.state = ARM_STATE.RETURN;
      }
      break;
    case ARM_STATE.RETURN:
      solveIK(robot.baseX, groundY - 180);
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        // Проверить, есть ли деталь для захвата
        if (leftParts.some(p => p.active && p.x >= pickX - 40)) {
          robot.state = ARM_STATE.MOVE_TO_PICK;
        } else {
          // ожидание
          robot.state = ARM_STATE.RETURN;
        }
      }
      break;
  }

  // Если держим деталь, двигаем её за схватом
  if (robot.partHeld) {
    robot.partHeld.x = tip.tx;
    robot.partHeld.y = tip.ty - 12;
    robot.partHeld.alpha = 1;
  }
}

// --- Обновление конвейеров и деталей ---
function updateConveyors() {
  beltOffset += 1.2;

  // Движение деталей на левом конвейере
  for (let part of leftParts) {
    if (part.active && part !== robot.partHeld) {
      if (part.x < pickX - 30) {
        part.x += 0.9;
      } else {
        part.x = pickX - 30;
      }
    }
  }
  // Удаляем уехавшие далеко (если вдруг проскочили)
  leftParts = leftParts.filter(p => p.x < canvas.width + 50);

  // Появление новых деталей
  spawnTimer++;
  if (spawnTimer >= SPAWN_DELAY && leftParts.length < 5) {
    spawnTimer = 0;
    leftParts.push(new Part(30, pickY));
  }

  // Движение деталей на правом конвейере (уезжают)
  for (let part of rightParts) {
    if (part.active) part.x += 0.8;
  }
  rightParts = rightParts.filter(p => p.x < canvas.width + 50);
}

// --- Отрисовка UI ---
function drawUI() {
  ctx.fillStyle = '#ecf0f1';
  ctx.font = 'bold 18px "Segoe UI", sans-serif';
  ctx.fillText('🤖 Роботизированное производство', 25, 35);
  ctx.font = '14px monospace';
  ctx.fillStyle = '#bdc3c7';
  ctx.fillText(`Перенесено деталей: ${partsMoved}`, 25, 60);
}

// --- Главный цикл ---
function gameLoop() {
  updateRobot();
  updateConveyors();
  updateParticles();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  // Детали
  for (let p of leftParts) drawPart(p);
  for (let p of rightParts) drawPart(p);

  drawRobotArm();
  drawParticles();
  drawUI();

  requestAnimationFrame(gameLoop);
}

// Запуск
gameLoop();

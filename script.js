const canvas = document.getElementById('factoryCanvas');
const ctx = canvas.getContext('2d');

// --- Размеры ---
function resize() {
  canvas.width = Math.min(1100, window.innerWidth - 20);
  canvas.height = Math.min(600, window.innerHeight - 20);
}
window.addEventListener('resize', resize);
resize();

// --- Конфигурация сцены ---
const groundY = canvas.height * 0.75;      // уровень пола
const conveyorLeftX = 100;
const conveyorRightX = canvas.width - 250;
const pickPos = { x: 220, y: groundY - 60 };   // точка захвата (над левым конвейером)
const placePos = { x: canvas.width - 120, y: groundY - 60 }; // точка установки (над правым)

// --- Состояния руки ---
const ARM_STATES = {
  MOVE_TO_PICK: 'moveToPick',
  DESCEND_PICK: 'descendPick',
  GRASP: 'grasp',
  LIFT_PICK: 'liftPick',
  MOVE_TO_PLACE: 'moveToPlace',
  DESCEND_PLACE: 'descendPlace',
  RELEASE: 'release',
  LIFT_PLACE: 'liftPlace',
  RETURN: 'return'
};

// --- Параметры робота ---
const robot = {
  baseX: canvas.width / 2,
  baseY: groundY,
  shoulderLength: 80,
  elbowLength: 70,
  gripperLength: 25,
  // Текущие углы (в радианах)
  shoulderAngle: 0,
  elbowAngle: 0,
  // Целевые углы
  targetShoulder: 0,
  targetElbow: 0,
  // Захват
  gripperOpen: 30,       // текущее расстояние между пальцами
  targetGripperOpen: 30,
  // Состояние
  state: ARM_STATES.MOVE_TO_PICK,
  progress: 0,           // 0..1 внутри состояния
  speed: 0.025,          // скорость анимации перехода
  partHeld: null,        // ссылка на деталь, которую держим
  idleTimer: 0
};

// --- Детали ---
class Part {
  constructor(x, y, width = 40, height = 30) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.color = '#7f8c8d';
    this.active = true;   // находится ли на конвейере и не захвачена
  }
}

let partsOnLeft = [];      // детали на левом конвейере
let partsOnRight = [];     // детали на правом (готовые)
const PART_WIDTH = 40;
const PART_HEIGHT = 30;
let spawnTimer = 0;
const SPAWN_DELAY = 120;   // кадров между появлением новых деталей

// Создаём первую деталь сразу
partsOnLeft.push(new Part(50, groundY - 20 - PART_HEIGHT/2, PART_WIDTH, PART_HEIGHT));

// --- Вспомогательные функции ---
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// Расчёт конечной точки схвата (tip) на основе углов
function getGripperTip() {
  const shoulderX = robot.baseX;
  const shoulderY = robot.baseY;
  // Плечо
  const elbowX = shoulderX + Math.cos(robot.shoulderAngle) * robot.shoulderLength;
  const elbowY = shoulderY - Math.sin(robot.shoulderAngle) * robot.shoulderLength;
  // Локоть + схват
  const wristAngle = robot.shoulderAngle + robot.elbowAngle;
  const wristX = elbowX + Math.cos(wristAngle) * robot.elbowLength;
  const wristY = elbowY - Math.sin(wristAngle) * robot.elbowLength;
  // Кончик схвата
  const tipX = wristX + Math.cos(wristAngle) * robot.gripperLength;
  const tipY = wristY - Math.sin(wristAngle) * robot.gripperLength;
  return { x: tipX, y: tipY, wristX, wristY, wristAngle };
}

// --- Отрисовка фона ---
function drawBackground() {
  // Пол
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);

  // Сетка на полу
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, groundY);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = groundY; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Конвейерные ленты (движущиеся полосы)
  drawConveyor(conveyorLeftX, groundY - 25, 150, 8);
  drawConveyor(conveyorRightX, groundY - 25, 150, 8);

  // Разметка зон
  ctx.font = '12px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('ПОДАЧА', conveyorLeftX + 40, groundY - 35);
  ctx.fillText('ПРИЁМ', conveyorRightX + 40, groundY - 35);

  // Платформа робота
  ctx.fillStyle = '#505050';
  ctx.fillRect(robot.baseX - 30, robot.baseY, 60, 15);
  ctx.fillStyle = '#707070';
  ctx.fillRect(robot.baseX - 20, robot.baseY - 12, 40, 12);
  // Лампочка на базе
  ctx.beginPath();
  ctx.arc(robot.baseX, robot.baseY - 18, 6, 0, Math.PI*2);
  ctx.fillStyle = robot.state === ARM_STATES.MOVE_TO_PICK || robot.state === ARM_STATES.DESCEND_PICK ? '#f1c40f' : '#2ecc71';
  ctx.fill();
  ctx.shadowBlur = 8;
  ctx.shadowColor = ctx.fillStyle;
  ctx.fill();
  ctx.shadowBlur = 0;
}

let conveyorOffset = 0;
function drawConveyor(x, y, width, height) {
  // Корпус конвейера
  ctx.fillStyle = '#404040';
  ctx.fillRect(x, y, width, height);
  // Ролики
  ctx.fillStyle = '#666';
  for (let i = 0; i < 5; i++) {
    const rx = x + 10 + i * 30;
    ctx.beginPath();
    ctx.arc(rx, y + height/2, height/2 + 2, 0, Math.PI*2);
    ctx.fill();
  }
  // Движущаяся лента (анимированные полосы)
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  const offset = (conveyorOffset % 30);
  for (let i = -30; i < width + 30; i += 30) {
    ctx.beginPath();
    ctx.moveTo(x + i + offset, y);
    ctx.lineTo(x + i + offset - 10, y + height);
    ctx.stroke();
  }
}

// --- Отрисовка деталей ---
function drawPart(part) {
  // Корпус детали
  ctx.fillStyle = part.color;
  ctx.fillRect(part.x - part.width/2, part.y - part.height/2, part.width, part.height);
  // Блик
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(part.x - part.width/2 + 4, part.y - part.height/2 + 2, part.width - 8, 4);
  // Тень
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(part.x - part.width/2, part.y + part.height/2, part.width, 3);
  // Обводка
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(part.x - part.width/2, part.y - part.height/2, part.width, part.height);
}

// --- Отрисовка руки робота ---
function drawRobotArm() {
  const { wristX, wristY, wristAngle } = getGripperTip();

  // Плечо
  const shoulderX = robot.baseX;
  const shoulderY = robot.baseY;
  const elbowX = shoulderX + Math.cos(robot.shoulderAngle) * robot.shoulderLength;
  const elbowY = shoulderY - Math.sin(robot.shoulderAngle) * robot.shoulderLength;

  // Сегмент плеча (толстая труба)
  ctx.save();
  ctx.translate(shoulderX, shoulderY);
  ctx.rotate(-robot.shoulderAngle);
  drawSegment(0, 0, robot.shoulderLength, 16);
  ctx.restore();

  // Локоть (сустав)
  ctx.beginPath();
  ctx.arc(elbowX, elbowY, 10, 0, Math.PI*2);
  ctx.fillStyle = '#777';
  ctx.fill();
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Предплечье
  ctx.save();
  ctx.translate(elbowX, elbowY);
  ctx.rotate(-(robot.shoulderAngle + robot.elbowAngle));
  drawSegment(0, 0, robot.elbowLength, 12);
  ctx.restore();

  // Захват
  ctx.save();
  ctx.translate(wristX, wristY);
  ctx.rotate(-wristAngle);

  // Основание схвата
  ctx.fillStyle = '#999';
  ctx.fillRect(-15, -5, 30, 10);
  // Пальцы (две губки)
  const open = robot.gripperOpen / 2;
  // Левая губка
  ctx.fillStyle = '#666';
  ctx.fillRect(-open - 18, -12, 16, 24);
  // Правая губка
  ctx.fillRect(open + 2, -12, 16, 24);
  // Штоки
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-open - 10, 0);
  ctx.lineTo(-open - 10, -14);
  ctx.moveTo(open + 10, 0);
  ctx.lineTo(open + 10, -14);
  ctx.stroke();

  ctx.restore();
}

function drawSegment(x1, y1, length, thickness) {
  // Основной цилиндр
  const grad = ctx.createLinearGradient(0, -thickness/2, 0, thickness/2);
  grad.addColorStop(0, '#aaa');
  grad.addColorStop(0.5, '#ddd');
  grad.addColorStop(1, '#888');
  ctx.fillStyle = grad;
  ctx.fillRect(0, -thickness/2, length, thickness);

  // Гидроцилиндр (пунктир)
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(length * 0.8, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  // Обводка
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, -thickness/2, length, thickness);
}

// --- Обновление логики ---
function update() {
  conveyorOffset += 1;  // анимация ленты

  // Движение деталей по левому конвейеру (если не захвачены)
  for (let part of partsOnLeft) {
    if (part.active && part !== robot.partHeld) {
      part.x += 0.7;
      // Если деталь достигла позиции захвата, останавливаем
      if (part.x >= pickPos.x - 20) {
        part.x = pickPos.x - 20;
      }
    }
  }

  // Удаляем детали, ушедшие за пределы (если не остановились)
  partsOnLeft = partsOnLeft.filter(p => p.x < pickPos.x + 50 || p === robot.partHeld);

  // Появление новых деталей
  spawnTimer++;
  if (spawnTimer >= SPAWN_DELAY) {
    spawnTimer = 0;
    partsOnLeft.push(new Part(30, groundY - 25 - PART_HEIGHT/2, PART_WIDTH, PART_HEIGHT));
  }

  // Логика состояний руки
  const tip = getGripperTip();
  switch (robot.state) {
    case ARM_STATES.MOVE_TO_PICK:
      // Поворачиваемся к позиции захвата
      {
        const targetShoulder = Math.atan2(-(pickPos.y - robot.baseY), pickPos.x - robot.baseX);
        // Вычисляем желаемый угол локтя для достижения pickPos
        // Решим обратную кинематику для двухзвенной руки
        const dx = pickPos.x - robot.baseX;
        const dy = -(pickPos.y - robot.baseY);
        const dist = Math.sqrt(dx*dx + dy*dy);
        const L1 = robot.shoulderLength;
        const L2 = robot.elbowLength + robot.gripperLength;
        if (dist < L1 + L2) {
          const cosElbow = (dist*dist - L1*L1 - L2*L2) / (2 * L1 * L2);
          const elbowAngle = Math.acos(Math.max(-1, Math.min(1, cosElbow)));
          const shoulderAngle = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(elbowAngle), L1 + L2 * Math.cos(elbowAngle));
          robot.targetShoulder = shoulderAngle;
          robot.targetElbow = elbowAngle;
        }
        robot.targetGripperOpen = 30;
        robot.progress += robot.speed;
        if (robot.progress >= 1) {
          robot.progress = 0;
          robot.state = ARM_STATES.DESCEND_PICK;
        }
      }
      break;
    case ARM_STATES.DESCEND_PICK:
      // Опускаем схват (слегка корректируем позицию по Y)
      // Реализуем как небольшое изменение целевой позиции (pickPos смещаем вниз)
      // Для простоты: добавим фиктивное движение, на самом деле pickPos уже низко
      robot.progress += robot.speed;
      if (robot.progress >= 0.5) {
        robot.progress = 0;
        robot.state = ARM_STATES.GRASP;
      }
      break;
    case ARM_STATES.GRASP:
      // Закрываем захват
      robot.targetGripperOpen = 5;
      robot.progress += robot.speed * 2;
      if (robot.progress >= 1) {
        // Берём деталь, если она есть в зоне
        const nearest = partsOnLeft.find(p => p.active && Math.abs(p.x - pickPos.x) < 25);
        if (nearest) {
          robot.partHeld = nearest;
          nearest.active = false;
        }
        robot.progress = 0;
        robot.state = ARM_STATES.LIFT_PICK;
      }
      break;
    case ARM_STATES.LIFT_PICK:
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        robot.state = ARM_STATES.MOVE_TO_PLACE;
      }
      break;
    case ARM_STATES.MOVE_TO_PLACE:
      {
        const dx = placePos.x - robot.baseX;
        const dy = -(placePos.y - robot.baseY);
        const dist = Math.sqrt(dx*dx + dy*dy);
        const L1 = robot.shoulderLength;
        const L2 = robot.elbowLength + robot.gripperLength;
        if (dist < L1 + L2) {
          const cosElbow = (dist*dist - L1*L1 - L2*L2) / (2 * L1 * L2);
          const elbowAngle = Math.acos(Math.max(-1, Math.min(1, cosElbow)));
          const shoulderAngle = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(elbowAngle), L1 + L2 * Math.cos(elbowAngle));
          robot.targetShoulder = shoulderAngle;
          robot.targetElbow = elbowAngle;
        }
        robot.targetGripperOpen = 5;
        robot.progress += robot.speed;
        if (robot.progress >= 1) {
          robot.progress = 0;
          robot.state = ARM_STATES.DESCEND_PLACE;
        }
      }
      break;
    case ARM_STATES.DESCEND_PLACE:
      robot.progress += robot.speed;
      if (robot.progress >= 0.5) {
        robot.progress = 0;
        robot.state = ARM_STATES.RELEASE;
      }
      break;
    case ARM_STATES.RELEASE:
      robot.targetGripperOpen = 30;
      robot.progress += robot.speed * 2;
      if (robot.progress >= 1) {
        // Отпускаем деталь: добавляем на правый конвейер
        if (robot.partHeld) {
          robot.partHeld.x = placePos.x;
          robot.partHeld.y = placePos.y;
          robot.partHeld.active = true;
          partsOnRight.push(robot.partHeld);
          robot.partHeld = null;
        }
        robot.progress = 0;
        robot.state = ARM_STATES.LIFT_PLACE;
      }
      break;
    case ARM_STATES.LIFT_PLACE:
      robot.progress += robot.speed;
      if (robot.progress >= 1) {
        robot.progress = 0;
        robot.state = ARM_STATES.RETURN;
      }
      break;
    case ARM_STATES.RETURN:
      // Возврат в исходное положение (над центром)
      {
        const idleX = robot.baseX;
        const idleY = robot.baseY - 150;
        const dx = idleX - robot.baseX;
        const dy = -(idleY - robot.baseY);
        const dist = Math.sqrt(dx*dx + dy*dy);
        const L1 = robot.shoulderLength;
        const L2 = robot.elbowLength + robot.gripperLength;
        if (dist < L1 + L2) {
          const cosElbow = (dist*dist - L1*L1 - L2*L2) / (2 * L1 * L2);
          const elbowAngle = Math.acos(Math.max(-1, Math.min(1, cosElbow)));
          const shoulderAngle = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(elbowAngle), L1 + L2 * Math.cos(elbowAngle));
          robot.targetShoulder = shoulderAngle;
          robot.targetElbow = elbowAngle;
        }
        robot.targetGripperOpen = 30;
        robot.progress += robot.speed;
        if (robot.progress >= 1) {
          robot.progress = 0;
          // Проверяем, есть ли деталь на левом конвейере готовая к захвату
          const readyPart = partsOnLeft.find(p => p.active && p.x >= pickPos.x - 30);
          if (readyPart) {
            robot.state = ARM_STATES.MOVE_TO_PICK;
          } else {
            // Ждём
            robot.idleTimer = 10;
            robot.state = ARM_STATES.RETURN; // остаёмся здесь
          }
        }
      }
      break;
  }

  // Плавное движение углов
  robot.shoulderAngle = lerpAngle(robot.shoulderAngle, robot.targetShoulder, 0.08);
  robot.elbowAngle = lerpAngle(robot.elbowAngle, robot.targetElbow, 0.08);
  robot.gripperOpen = lerp(robot.gripperOpen, robot.targetGripperOpen, 0.15);

  // Если держим деталь, перемещаем её за схватом
  if (robot.partHeld) {
    const tip = getGripperTip();
    robot.partHeld.x = tip.x;
    robot.partHeld.y = tip.y - 15;
  }

  // Движение деталей на правом конвейере (уезжают)
  for (let part of partsOnRight) {
    if (part.active) {
      part.x += 0.6;
    }
  }
  partsOnRight = partsOnRight.filter(p => p.x < canvas.width + 50);
}

// --- Главный цикл отрисовки ---
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  // Детали на левом конвейере
  for (let part of partsOnLeft) {
    drawPart(part);
  }
  // Детали на правом конвейере
  for (let part of partsOnRight) {
    drawPart(part);
  }

  drawRobotArm();

  // Информация
  ctx.fillStyle = '#aaa';
  ctx.font = '14px monospace';
  ctx.fillText('Роботизированное производство — макет', 20, 30);
  ctx.fillText('Механическая рука переносит детали с левого конвейера на правый', 20, 50);
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

loop();

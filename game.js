"use strict";

// 游戏逻辑使用固定的世界尺寸，Canvas 只负责按窗口大小缩放显示。
const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 540;
const LOOP_DURATION = 30;
const BULLET_SPEED = 620;
const RESET_EFFECT_DURATION = 1.25;
const LOOP_WARNING_TIME = 5;
const POSE_INTERVAL = 1 / 30;
const MAX_ECHOES = 1;
const RESONANCE_WINDOW = 0.8;
const ARENA_CENTER_X = WORLD_WIDTH / 2;
const ARENA_CENTER_Y = 306;
const ARENA_LOBE_OFFSET = 175;
const ARENA_RADIUS = 190;
const ARENA_ACTOR_RADIUS = 180;
const ARENA_GATE_RADIUS = 48;
const TIMELINE_SWAP_COOLDOWN = 1.1;

function getLobeCenter(side) {
  return {
    x: ARENA_CENTER_X + ARENA_LOBE_OFFSET * side,
    y: ARENA_CENTER_Y,
  };
}

// 时间线统一记录为右环坐标；进入左环时只需水平镜像。
function mapCanonicalX(x, side) {
  return side > 0 ? x : ARENA_CENTER_X * 2 - x;
}

function mapCanonicalAngle(angle, side) {
  return side > 0 ? angle : Math.PI - angle;
}

function mapCanonicalDirectionX(directionX, side) {
  return side > 0 ? directionX : -directionX;
}

function constrainActorToLobe(actor, side) {
  const center = getLobeCenter(side);
  const offsetX = actor.x - center.x;
  const offsetY = actor.y - center.y;
  const distance = Math.hypot(offsetX, offsetY);
  if (distance <= ARENA_ACTOR_RADIUS || distance === 0) return;
  actor.x = center.x + (offsetX / distance) * ARENA_ACTOR_RADIUS;
  actor.y = center.y + (offsetY / distance) * ARENA_ACTOR_RADIUS;
}

const GAME_STATE = Object.freeze({
  TITLE: "TITLE",
  PLAYING: "PLAYING",
  LOOP_COLLAPSE: "LOOP_COLLAPSE",
  UPGRADE_SELECT: "UPGRADE_SELECT",
  VICTORY: "VICTORY",
});

const UPGRADE_POOL = [
  { id: "damage", title: "火力增幅", description: "所有未来子弹伤害 +20%" },
  { id: "fireRate", title: "快速射击", description: "射击间隔缩短 15%" },
  { id: "movement", title: "机动强化", description: "当前玩家移动速度 +12%" },
  { id: "health", title: "生命扩容", description: "最大生命值 +25" },
  { id: "pierce", title: "穿透回响", description: "当前穿透 +1，Echo 额外 +1" },
  { id: "explosion", title: "爆裂回响", description: "命中产生爆炸，Echo 范围更大" },
];

// 检测两个圆形物体是否发生接触。
function circlesOverlap(first, second) {
  const distance = Math.hypot(first.x - second.x, first.y - second.y);
  return distance <= first.radius + second.radius;
}

// 用子弹一帧内的飞行线段检测敌人，避免高速子弹直接穿过目标。
function segmentHitsCircle(startX, startY, endX, endY, circle) {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  let progress = 0;
  if (segmentLengthSquared > 0) {
    progress =
      ((circle.x - startX) * segmentX + (circle.y - startY) * segmentY) /
      segmentLengthSquared;
    progress = Math.max(0, Math.min(1, progress));
  }

  const closestX = startX + segmentX * progress;
  const closestY = startY + segmentY * progress;
  const hitRadius = circle.radius + 4;
  return Math.hypot(circle.x - closestX, circle.y - closestY) <= hitRadius;
}

function interpolateAngle(from, to, amount) {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + difference * amount;
}

function copyWeapon(weapon) {
  return {
    damage: weapon.damage,
    penetration: weapon.penetration,
    explosionRadius: weapon.explosionRadius,
    speed: weapon.speed,
    echoPenetration: weapon.echoPenetration,
    echoExplosionRadius: weapon.echoExplosionRadius,
  };
}

class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.mouse = {
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      shooting: false,
      clicked: false,
    };

    window.addEventListener("keydown", (event) => {
      if (!this.keys.has(event.code)) this.pressedKeys.add(event.code);
      this.keys.add(event.code);
    });

    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
    });

    canvas.addEventListener("mousemove", (event) => this.updateMousePosition(event));
    canvas.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        this.mouse.shooting = true;
        this.mouse.clicked = true;
        this.updateMousePosition(event);
      }
    });

    window.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.mouse.shooting = false;
    });

    // 窗口失去焦点时清空输入，避免按键或射击状态卡住。
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pressedKeys.clear();
      this.mouse.shooting = false;
      this.mouse.clicked = false;
    });

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  updateMousePosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * WORLD_WIDTH;
    this.mouse.y = ((event.clientY - rect.top) / rect.height) * WORLD_HEIGHT;
  }

  getMovement() {
    let x = 0;
    let y = 0;

    if (this.keys.has("KeyA")) x -= 1;
    if (this.keys.has("KeyD")) x += 1;
    if (this.keys.has("KeyW")) y -= 1;
    if (this.keys.has("KeyS")) y += 1;

    // 斜向移动时归一化，保证各方向速度一致。
    const length = Math.hypot(x, y);
    return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  }

  consumeKey(code) {
    if (!this.pressedKeys.has(code)) return false;
    this.pressedKeys.delete(code);
    return true;
  }

  consumeClick() {
    if (!this.mouse.clicked) return false;
    this.mouse.clicked = false;
    return true;
  }

  clearTransient() {
    this.pressedKeys.clear();
    this.mouse.clicked = false;
  }
}

class SoundManager {
  constructor() {
    this.context = null;
  }

  unlock() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!this.context) this.context = new AudioContextClass();
    if (this.context.state === "suspended") this.context.resume();
  }

  tone(startFrequency, endFrequency, duration, type, volume, delay = 0) {
    if (!this.context || this.context.state !== "running") return;
    const startTime = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequency),
      startTime + duration,
    );
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  }

  play(name) {
    if (name === "shoot") this.tone(440, 190, 0.055, "square", 0.025);
    if (name === "echoShoot") this.tone(680, 330, 0.07, "triangle", 0.018);
    if (name === "hit") this.tone(120, 72, 0.045, "square", 0.018);
    if (name === "death") this.tone(170, 42, 0.22, "sawtooth", 0.04);
    if (name === "collapse") this.tone(320, 35, 0.75, "sawtooth", 0.055);
    if (name === "upgrade") {
      this.tone(330, 440, 0.16, "triangle", 0.04);
      this.tone(440, 660, 0.2, "triangle", 0.035, 0.12);
    }
    if (name === "resonance") {
      this.tone(180, 720, 0.3, "sawtooth", 0.055);
      this.tone(360, 1080, 0.28, "triangle", 0.045, 0.03);
    }
    if (name === "shield") {
      this.tone(90, 540, 0.45, "square", 0.055);
      this.tone(240, 960, 0.34, "triangle", 0.04, 0.06);
    }
    if (name === "swap") {
      this.tone(760, 180, 0.22, "triangle", 0.04);
      this.tone(180, 820, 0.26, "sine", 0.035, 0.04);
    }
    if (name === "victory") {
      [440, 554, 659, 880].forEach((frequency, index) => {
        this.tone(frequency, frequency * 1.03, 0.32, "triangle", 0.045, index * 0.13);
      });
    }
  }
}

class Bullet {
  constructor(
    x,
    y,
    directionX,
    directionY,
    {
      source = "current",
      speed = BULLET_SPEED,
      damage = 20,
      penetration = 0,
      explosionRadius = 0,
      radius = 4,
      maxFlightTime = Infinity,
      record = null,
      isEcho = false,
    } = {},
  ) {
    this.x = x;
    this.y = y;
    this.previousX = x;
    this.previousY = y;
    this.velocityX = directionX * speed;
    this.velocityY = directionY * speed;
    this.radius = radius;
    this.active = true;
    this.source = isEcho ? "echo" : source;
    this.isEcho = this.source === "echo";
    this.damage = damage;
    this.remainingPenetration = penetration;
    this.explosionRadius = explosionRadius;
    this.hitTargets = new Set();
    this.maxFlightTime = maxFlightTime;
    this.age = 0;
    this.record = record;
  }

  update(deltaTime) {
    this.previousX = this.x;
    this.previousY = this.y;
    this.x += this.velocityX * deltaTime;
    this.y += this.velocityY * deltaTime;
    this.age += deltaTime;

    // 当前轮子弹持续回写生存时长，形成下一轮的完整轨迹记录。
    if (this.record) {
      this.record.flightTime = this.age;
      this.record.disappearTime = this.record.spawnTime + this.age;
    }

    const margin = 20;
    if (
      this.x < -margin ||
      this.x > WORLD_WIDTH + margin ||
      this.y < -margin ||
      this.y > WORLD_HEIGHT + margin ||
      this.age >= this.maxFlightTime
    ) {
      this.deactivate();
    }
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;

    if (this.record) {
      this.record.flightTime = this.age;
      this.record.disappearTime = this.record.spawnTime + this.age;
    }
  }

  canHit(entityId) {
    return this.active && !this.hitTargets.has(entityId);
  }

  consumeHit(entityId) {
    this.hitTargets.add(entityId);
    if (this.remainingPenetration > 0) {
      this.remainingPenetration -= 1;
    } else {
      this.deactivate();
    }
  }

  draw(context) {
    context.save();
    const isHostileBullet = this.source === "boss" || this.source === "enemy";
    context.globalAlpha = this.isEcho ? 0.62 : 1;
    context.shadowColor = isHostileBullet ? "#ff335c" : this.isEcho ? "#38bfff" : "#ffffff";
    context.shadowBlur = this.isEcho ? 16 : 10;
    context.fillStyle = isHostileBullet ? "#ff496a" : this.isEcho ? "#62d5ff" : "#ffffff";

    // 回响子弹使用更长的蓝色拖尾，与当前轮白色子弹明显区分。
    const speed = Math.hypot(this.velocityX, this.velocityY) || 1;
    const trailLength = this.isEcho ? 30 : isHostileBullet ? 18 : 12;
    const trailX = this.x - (this.velocityX / speed) * trailLength;
    const trailY = this.y - (this.velocityY / speed) * trailLength;
    context.strokeStyle = isHostileBullet
      ? "rgba(255, 54, 91, 0.35)"
      : this.isEcho
        ? "rgba(82, 207, 255, 0.38)"
        : "rgba(255, 255, 255, 0.24)";
    context.lineWidth = this.isEcho ? 5 : 2;
    context.beginPath();
    context.moveTo(trailX, trailY);
    context.lineTo(this.x, this.y);
    context.stroke();

    context.beginPath();
    context.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

class TimeShard {
  constructor(x, y, direction) {
    this.x = x;
    this.y = y;
    this.velocityX = direction * (260 + Math.random() * 620);
    this.velocityY = (Math.random() - 0.5) * 150;
    this.width = 12 + Math.random() * 42;
    this.height = 1 + Math.random() * 3;
    this.maxLife = 0.35 + Math.random() * 0.65;
    this.life = this.maxLife;
  }

  update(deltaTime) {
    this.x += this.velocityX * deltaTime;
    this.y += this.velocityY * deltaTime;
    this.life -= deltaTime;
  }

  draw(context) {
    const alpha = Math.max(0, this.life / this.maxLife);
    context.save();
    context.globalAlpha = alpha * 0.75;
    context.shadowColor = "#53d8ff";
    context.shadowBlur = 8;
    context.fillStyle = Math.random() > 0.2 ? "#8ce8ff" : "#ffffff";
    context.fillRect(this.x, this.y, this.width, this.height);
    context.restore();
  }
}

class ExplosionEffect {
  constructor(x, y, radius, color) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.color = color;
    this.life = 0.32;
    this.maxLife = this.life;
  }

  update(deltaTime) {
    this.life -= deltaTime;
  }

  draw(context) {
    const progress = 1 - Math.max(0, this.life / this.maxLife);
    context.save();
    context.globalAlpha = 1 - progress;
    context.strokeStyle = this.color;
    context.lineWidth = 5 * (1 - progress) + 1;
    context.shadowColor = this.color;
    context.shadowBlur = 18;
    context.beginPath();
    context.arc(this.x, this.y, this.radius * progress, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

class ImpactParticle {
  constructor(x, y, color, force = 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (55 + Math.random() * 170) * force;
    this.x = x;
    this.y = y;
    this.velocityX = Math.cos(angle) * speed;
    this.velocityY = Math.sin(angle) * speed;
    this.color = color;
    this.size = 1.5 + Math.random() * 3.5;
    this.life = 0.28 + Math.random() * 0.34;
    this.maxLife = this.life;
  }

  update(deltaTime) {
    this.x += this.velocityX * deltaTime;
    this.y += this.velocityY * deltaTime;
    this.velocityX *= 0.94;
    this.velocityY *= 0.94;
    this.life -= deltaTime;
  }

  draw(context) {
    context.save();
    context.globalAlpha = Math.max(0, this.life / this.maxLife);
    context.fillStyle = this.color;
    context.fillRect(this.x, this.y, this.size, this.size);
    context.restore();
  }
}

class FloatingText {
  constructor(x, y, text, color = "#ffffff", size = 15) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.color = color;
    this.size = size;
    this.life = 0.72;
    this.maxLife = this.life;
  }

  update(deltaTime) {
    this.y -= 34 * deltaTime;
    this.life -= deltaTime;
  }

  draw(context) {
    context.save();
    context.globalAlpha = Math.max(0, this.life / this.maxLife);
    context.textAlign = "center";
    context.font = `bold ${this.size}px "Segoe UI", sans-serif`;
    context.fillStyle = this.color;
    context.shadowColor = this.color;
    context.shadowBlur = 8;
    context.fillText(this.text, this.x, this.y);
    context.restore();
  }
}

class Enemy {
  constructor(x, y, speed, health = 30, entityId = 0, type = "chaser") {
    this.x = x;
    this.y = y;
    this.type = type;
    this.radius = type === "splitter" ? 20 : type === "mini" ? 9 : type === "sniper" ? 14 : 15;
    this.speed = speed * (type === "splitter" ? 0.75 : type === "mini" ? 1.35 : 1);
    const healthMultiplier = type === "splitter" ? 1.55 : type === "mini" ? 0.42 : 1;
    this.maxHealth = health * healthMultiplier;
    this.health = this.maxHealth;
    this.entityId = entityId;
    this.active = true;
    this.rewarded = false;
    this.currentHitTimer = 0;
    this.echoHitTimer = 0;
    this.attackCooldown = 1.8 + Math.random();
    this.telegraphTimer = 0;
    this.aimX = x;
    this.aimY = y;
  }

  update(deltaTime, targets, onShoot = () => {}) {
    this.currentHitTimer = Math.max(0, this.currentHitTimer - deltaTime);
    this.echoHitTimer = Math.max(0, this.echoHitTimer - deltaTime);
    const targetList = Array.isArray(targets) ? targets : [targets];
    const livingTargets = targetList.filter((target) => target && target.active !== false && target.health > 0);
    if (livingTargets.length === 0) return;

    let nearest = livingTargets[0];
    let nearestDistance = Math.hypot(nearest.x - this.x, nearest.y - this.y);
    for (let index = 1; index < livingTargets.length; index += 1) {
      const candidate = livingTargets[index];
      const distance = Math.hypot(candidate.x - this.x, candidate.y - this.y);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }

    const directionX = nearest.x - this.x;
    const directionY = nearest.y - this.y;
    const distance = Math.hypot(directionX, directionY);

    if (this.type === "sniper") {
      if (this.telegraphTimer > 0) {
        this.aimX = nearest.x;
        this.aimY = nearest.y;
        this.telegraphTimer -= deltaTime;
        if (this.telegraphTimer <= 0) onShoot(this, { x: this.aimX, y: this.aimY });
        return;
      }

      this.attackCooldown -= deltaTime;
      if (this.attackCooldown <= 0) {
        this.telegraphTimer = 0.9;
        this.attackCooldown = 3.2;
        this.aimX = nearest.x;
        this.aimY = nearest.y;
        return;
      }

      if (distance > 330) {
        this.x += (directionX / distance) * this.speed * 0.65 * deltaTime;
        this.y += (directionY / distance) * this.speed * 0.65 * deltaTime;
      } else if (distance > 0 && distance < 210) {
        this.x -= (directionX / distance) * this.speed * 0.55 * deltaTime;
        this.y -= (directionY / distance) * this.speed * 0.55 * deltaTime;
      }
    } else if (distance > 0) {
      this.x += (directionX / distance) * this.speed * deltaTime;
      this.y += (directionY / distance) * this.speed * deltaTime;
    }
  }

  registerTemporalHit(source) {
    if (source === "current") this.currentHitTimer = RESONANCE_WINDOW;
    if (source === "echo") this.echoHitTimer = RESONANCE_WINDOW;
    if (this.currentHitTimer > 0 && this.echoHitTimer > 0) {
      this.currentHitTimer = 0;
      this.echoHitTimer = 0;
      return true;
    }
    return false;
  }

  takeDamage(amount) {
    if (!this.active) return false;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.active = false;
      return true;
    }
    return false;
  }

  draw(context) {
    if (this.type === "sniper" && this.telegraphTimer > 0) {
      const pulse = 0.45 + Math.sin(this.telegraphTimer * 24) * 0.25;
      context.save();
      context.strokeStyle = `rgba(255, 48, 83, ${pulse})`;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(this.x, this.y);
      context.lineTo(this.aimX, this.aimY);
      context.stroke();
      context.restore();
    }

    context.save();
    context.translate(this.x, this.y);
    context.shadowColor = "#ff284f";
    context.shadowBlur = 14;
    context.fillStyle = this.type === "sniper" ? "#9f2146" : this.type === "splitter" ? "#b52d35" : "#d92243";
    context.strokeStyle = this.type === "sniper" ? "#ff9ab1" : "#ff718b";
    context.lineWidth = 2;
    context.beginPath();
    if (this.type === "sniper") {
      context.moveTo(0, -this.radius);
      context.lineTo(this.radius, 0);
      context.lineTo(0, this.radius);
      context.lineTo(-this.radius, 0);
      context.closePath();
    } else {
      context.arc(0, 0, this.radius, 0, Math.PI * 2);
    }
    context.fill();
    context.stroke();

    context.fillStyle = "#ffd4dc";
    if (this.type === "splitter") {
      context.fillRect(-2, -12, 4, 24);
      context.fillRect(-12, -2, 24, 4);
    } else {
      context.fillRect(-7, -3, 4, 6);
      context.fillRect(3, -3, 4, 6);
    }
    context.restore();

    if (this.health < this.maxHealth) {
      context.fillStyle = "rgba(255,255,255,0.14)";
      context.fillRect(this.x - this.radius, this.y - this.radius - 9, this.radius * 2, 3);
      context.fillStyle = "#ff4b69";
      context.fillRect(
        this.x - this.radius,
        this.y - this.radius - 9,
        this.radius * 2 * (this.health / this.maxHealth),
        3,
      );
    }
  }
}

class EchoActor {
  constructor(timeline, echoIndex, side = -1) {
    this.timeline = timeline;
    this.echoIndex = echoIndex;
    this.side = side;
    this.entityId = `echo-${echoIndex}`;
    this.radius = 16;
    this.maxHealth = 70;
    this.health = this.maxHealth;
    this.active = timeline.poses.length > 0;
    this.x = mapCanonicalX(timeline.poses[0]?.x ?? getLobeCenter(1).x, this.side);
    this.y = timeline.poses[0]?.y ?? WORLD_HEIGHT / 2;
    this.aimAngle = mapCanonicalAngle(timeline.poses[0]?.aimAngle ?? 0, this.side);
    this.poseIndex = 0;
    this.shotIndex = 0;
    this.spawnPulse = 1;
  }

  setSide(side) {
    if (this.side === side) return;
    this.side = side;
    this.spawnPulse = 1;
  }

  update(deltaTime, loopElapsed, onShoot) {
    if (!this.active) return;
    this.spawnPulse = Math.max(0, this.spawnPulse - deltaTime * 1.5);

    if (loopElapsed > this.timeline.duration) {
      this.active = false;
      return;
    }

    const poses = this.timeline.poses;
    while (
      this.poseIndex + 1 < poses.length &&
      poses[this.poseIndex + 1].time <= loopElapsed
    ) {
      this.poseIndex += 1;
    }

    const currentPose = poses[this.poseIndex];
    const nextPose = poses[Math.min(this.poseIndex + 1, poses.length - 1)];
    const poseDuration = Math.max(0.0001, nextPose.time - currentPose.time);
    const amount = Math.max(0, Math.min(1, (loopElapsed - currentPose.time) / poseDuration));
    const canonicalX = currentPose.x + (nextPose.x - currentPose.x) * amount;
    this.y = currentPose.y + (nextPose.y - currentPose.y) * amount;
    const canonicalAim = interpolateAngle(currentPose.aimAngle, nextPose.aimAngle, amount);
    this.x = mapCanonicalX(canonicalX, this.side);
    this.aimAngle = mapCanonicalAngle(canonicalAim, this.side);

    while (
      this.shotIndex < this.timeline.shots.length &&
      this.timeline.shots[this.shotIndex].time <= loopElapsed
    ) {
      const shot = this.timeline.shots[this.shotIndex];
      onShoot({
        ...shot,
        x: mapCanonicalX(shot.x, this.side),
        directionX: mapCanonicalDirectionX(shot.directionX, this.side),
      }, this);
      this.shotIndex += 1;
    }
  }

  takeDamage(amount) {
    if (!this.active) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this.active = false;
    return true;
  }

  draw(context) {
    if (!this.active) return;
    context.save();
    context.translate(this.x, this.y);
    context.rotate(this.aimAngle);
    context.globalAlpha = 0.5;
    context.shadowColor = "#46d6ff";
    context.shadowBlur = 20;
    context.strokeStyle = "#8feaff";
    context.fillStyle = "#147cad";
    context.lineWidth = 2;
    context.fillRect(6, -4, 23, 8);
    context.beginPath();
    context.arc(0, 0, this.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();

    context.save();
    context.globalAlpha = 0.8;
    context.fillStyle = "rgba(60, 205, 255, 0.18)";
    context.fillRect(this.x - 17, this.y - 25, 34, 3);
    context.fillStyle = "#62dcff";
    context.fillRect(this.x - 17, this.y - 25, 34 * (this.health / this.maxHealth), 3);
    if (this.spawnPulse > 0) {
      context.globalAlpha = this.spawnPulse;
      context.strokeStyle = "#77e5ff";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(this.x, this.y, 20 + (1 - this.spawnPulse) * 70, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }
}

class Player {
  constructor(x, y) {
    this.entityId = "player";
    this.x = x;
    this.y = y;
    this.radius = 18;
    this.speed = 250;
    this.aimAngle = 0;
    this.fireInterval = 0.13;
    this.fireCooldown = 0;
    this.maxHealth = 100;
    this.health = this.maxHealth;
    this.invulnerabilityTime = 0;
    this.active = true;
  }

  update(deltaTime, input, onShoot) {
    this.invulnerabilityTime = Math.max(0, this.invulnerabilityTime - deltaTime);
    if (this.health <= 0) return;

    const movement = input.getMovement();
    this.x += movement.x * this.speed * deltaTime;
    this.y += movement.y * this.speed * deltaTime;

    // 玩家始终被限制在画面内。
    this.x = Math.max(this.radius, Math.min(WORLD_WIDTH - this.radius, this.x));
    this.y = Math.max(this.radius, Math.min(WORLD_HEIGHT - this.radius, this.y));

    this.aimAngle = Math.atan2(input.mouse.y - this.y, input.mouse.x - this.x);
    this.fireCooldown = Math.max(0, this.fireCooldown - deltaTime);

    if (input.mouse.shooting && this.fireCooldown <= 0) {
      this.shoot(onShoot);
      this.fireCooldown = this.fireInterval;
    }
  }

  takeDamage(amount) {
    if (this.invulnerabilityTime > 0 || this.health <= 0) return false;

    this.health = Math.max(0, this.health - amount);
    this.invulnerabilityTime = 0.7;
    return true;
  }

  applyProgression(progression) {
    if (!progression) return;
    this.speed = 250 * progression.movementMultiplier;
    this.fireInterval = 0.13 * progression.fireRateMultiplier;
    this.maxHealth = 100 + progression.maxHealthBonus;
    this.health = Math.min(this.health, this.maxHealth);
  }

  shoot(onShoot) {
    const directionX = Math.cos(this.aimAngle);
    const directionY = Math.sin(this.aimAngle);
    const muzzleDistance = this.radius + 9;

    onShoot(
      this.x + directionX * muzzleDistance,
      this.y + directionY * muzzleDistance,
      directionX,
      directionY,
    );
  }

  reset(x, y, progression = null) {
    this.x = x;
    this.y = y;
    this.aimAngle = 0;
    this.fireCooldown = 0;
    this.applyProgression(progression);
    this.health = this.maxHealth;
    this.invulnerabilityTime = 0;
    this.active = true;
  }

  draw(context) {
    context.save();
    // 受伤后的短暂无敌期间闪烁。
    if (this.invulnerabilityTime > 0 && Math.floor(this.invulnerabilityTime * 14) % 2 === 0) {
      context.globalAlpha = 0.35;
    }
    context.translate(this.x, this.y);
    context.rotate(this.aimAngle);

    // 朝向鼠标的炮管。
    context.fillStyle = "#a8efff";
    context.fillRect(7, -5, 24, 10);

    // 简单的圆形机器人主体。
    context.shadowColor = "#20c8ff";
    context.shadowBlur = 18;
    context.fillStyle = "#169ed1";
    context.strokeStyle = "#90eaff";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, this.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.fillStyle = "#e7fbff";
    context.beginPath();
    context.arc(6, 0, 4, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

class Boss {
  constructor(entityId) {
    this.entityId = entityId;
    this.x = ARENA_CENTER_X;
    this.y = ARENA_CENTER_Y;
    this.radius = 44;
    this.maxHealth = 480;
    this.health = this.maxHealth;
    this.active = true;
    this.shotCooldown = 1.6;
    this.presentMarkTimer = 0;
    this.pastMarkTimer = 0;
    this.shieldBreakTimer = 0;
    this.hitFlash = 0;
  }

  update(deltaTime, targets, onRingShot) {
    if (!this.active) return;
    this.presentMarkTimer = Math.max(0, this.presentMarkTimer - deltaTime);
    this.pastMarkTimer = Math.max(0, this.pastMarkTimer - deltaTime);
    this.shieldBreakTimer = Math.max(0, this.shieldBreakTimer - deltaTime);
    this.hitFlash = Math.max(0, this.hitFlash - deltaTime);

    // Boss 固定在 ∞ 的交点，迫使左右时间环同时向中心开火。
    void targets;

    this.shotCooldown -= deltaTime;
    if (this.shotCooldown <= 0) {
      onRingShot(this);
      this.shotCooldown = 2.3;
    }
  }

  receiveBullet(bullet) {
    if (!this.active) return { killed: false, shieldBroken: false };

    if (this.shieldBreakTimer > 0) {
      this.health = Math.max(0, this.health - bullet.damage);
      this.hitFlash = 0.12;
      if (this.health <= 0) {
        this.active = false;
        return { killed: true, shieldBroken: false };
      }
      return { killed: false, shieldBroken: false };
    }

    if (bullet.source === "current") this.presentMarkTimer = 1.5;
    if (bullet.source === "echo") this.pastMarkTimer = 1.5;

    if (this.presentMarkTimer > 0 && this.pastMarkTimer > 0) {
      this.presentMarkTimer = 0;
      this.pastMarkTimer = 0;
      this.shieldBreakTimer = 3;
      return { killed: false, shieldBroken: true };
    }

    return { killed: false, shieldBroken: false };
  }

  draw(context) {
    if (!this.active) return;
    const vulnerable = this.shieldBreakTimer > 0;
    context.save();
    context.translate(this.x, this.y);
    context.shadowColor = vulnerable ? "#ff496a" : "#b34fff";
    context.shadowBlur = 24;
    context.fillStyle = this.hitFlash > 0 ? "#ffffff" : "#8c1731";
    context.strokeStyle = "#ff6683";
    context.lineWidth = 5;
    context.beginPath();
    context.arc(0, 0, this.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.fillStyle = "#ffd7df";
    context.fillRect(-22, -6, 13, 12);
    context.fillRect(9, -6, 13, 12);

    if (!vulnerable) {
      context.globalAlpha = 0.75;
      context.strokeStyle = "#b76cff";
      context.lineWidth = 4;
      context.beginPath();
      context.arc(0, 0, this.radius + 13, 0, Math.PI * 2);
      context.stroke();

      context.strokeStyle = this.presentMarkTimer > 0 ? "#ffffff" : "rgba(255,255,255,0.2)";
      context.beginPath();
      context.arc(0, 0, this.radius + 20, -Math.PI / 2, Math.PI / 2);
      context.stroke();
      context.strokeStyle = this.pastMarkTimer > 0 ? "#54d9ff" : "rgba(84,217,255,0.2)";
      context.beginPath();
      context.arc(0, 0, this.radius + 20, Math.PI / 2, Math.PI * 1.5);
      context.stroke();
    }
    context.restore();
  }
}

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.input = new InputManager(canvas);
    this.sound = new SoundManager();
    const presentSpawn = getLobeCenter(1);
    this.player = new Player(presentSpawn.x + 52, presentSpawn.y);
    this.playerSide = 1;
    this.timelineSwapCooldown = 0;
    this.timelineSwapPulse = 0;
    this.timelineSwapCount = 0;
    this.bullets = [];
    this.echoes = [];
    this.enemies = [];
    this.effects = [];
    this.particles = [];
    this.floatingTexts = [];
    this.boss = null;
    this.enemySpawnTimer = 0.45;
    this.maxEnemies = 32;
    this.kills = 0;
    this.score = 0;
    this.currentLoop = 1;
    this.loopElapsed = 0;
    this.state = GAME_STATE.TITLE;
    this.stateTimer = 0;
    this.transitionTimer = 0;
    this.transitionLabel = "TIME RESET";
    this.collapseReason = "time";
    this.timelines = [];
    this.currentTimeline = null;
    this.poseAccumulator = 0;
    this.upgradeOptions = [];
    this.progression = {
      damageMultiplier: 1,
      fireRateMultiplier: 1,
      movementMultiplier: 1,
      maxHealthBonus: 0,
      penetration: 0,
      explosionLevel: 0,
    };
    this.upgradeCounts = Object.fromEntries(UPGRADE_POOL.map((upgrade) => [upgrade.id, 0]));
    this.entityCounter = 1;
    this.bossBreakFlash = 0;
    this.hitStopTimer = 0;
    this.slowMotionTimer = 0;
    this.impactShake = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.resonanceCount = 0;
    this.timeShards = [];
    this.resetOrigin = { x: presentSpawn.x + 52, y: presentSpawn.y, aimAngle: Math.PI };
    this.resetEnemySequence();
    this.player.applyProgression(this.progression);
    this.startTimelineRecording();
    this.lastTime = performance.now();

    this.resizeCanvas();
    canvas.addEventListener("mousedown", () => this.sound.unlock());
    window.addEventListener("keydown", () => this.sound.unlock());
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  resizeCanvas() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = WORLD_WIDTH * pixelRatio;
    this.canvas.height = WORLD_HEIGHT * pixelRatio;

    // 之后所有绘制继续使用 960 × 540 的世界坐标。
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  start() {
    requestAnimationFrame((time) => this.loop(time));
  }

  loop(currentTime) {
    // 限制最大 delta，防止切换窗口后物体瞬移。
    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.05);
    this.lastTime = currentTime;

    this.update(deltaTime);
    this.draw();
    requestAnimationFrame((time) => this.loop(time));
  }

  update(deltaTime) {
    this.transitionTimer = Math.max(0, this.transitionTimer - deltaTime);
    this.bossBreakFlash = Math.max(0, this.bossBreakFlash - deltaTime);
    this.timelineSwapCooldown = Math.max(0, this.timelineSwapCooldown - deltaTime);
    this.timelineSwapPulse = Math.max(0, this.timelineSwapPulse - deltaTime);
    this.impactShake = Math.max(0, this.impactShake - deltaTime * 24);
    this.comboTimer = Math.max(0, this.comboTimer - deltaTime);
    if (this.comboTimer <= 0) this.combo = 0;
    this.timeShards.forEach((shard) => shard.update(deltaTime));
    this.timeShards = this.timeShards.filter((shard) => shard.life > 0);
    this.effects.forEach((effect) => effect.update(deltaTime));
    this.effects = this.effects.filter((effect) => effect.life > 0);
    this.particles.forEach((particle) => particle.update(deltaTime));
    this.particles = this.particles.filter((particle) => particle.life > 0);
    this.floatingTexts.forEach((textEffect) => textEffect.update(deltaTime));
    this.floatingTexts = this.floatingTexts.filter((textEffect) => textEffect.life > 0);

    if (this.state === GAME_STATE.TITLE) {
      if (
        this.input.consumeKey("Enter") ||
        this.input.consumeKey("Space") ||
        this.input.consumeClick()
      ) {
        this.sound.unlock();
        this.restartGame();
      }
      return;
    }

    if (this.state === GAME_STATE.VICTORY) {
      if (this.input.consumeKey("KeyR")) this.restartGame();
      return;
    }

    if (this.state === GAME_STATE.UPGRADE_SELECT) {
      this.handleUpgradeSelection();
      return;
    }

    if (this.state === GAME_STATE.LOOP_COLLAPSE) {
      this.stateTimer -= deltaTime;
      if (this.stateTimer <= 0) this.enterUpgradeSelection();
      return;
    }

    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - deltaTime);
      this.input.clearTransient();
      return;
    }

    if (this.slowMotionTimer > 0) {
      this.slowMotionTimer = Math.max(0, this.slowMotionTimer - deltaTime);
      deltaTime *= 0.36;
    }

    this.loopElapsed = Math.min(LOOP_DURATION, this.loopElapsed + deltaTime);

    const previousPlayerX = this.player.x;
    this.player.update(deltaTime, this.input, (x, y, directionX, directionY) => {
      this.firePlayerBullet(x, y, directionX, directionY);
    });
    this.handleTimelineCrossing(previousPlayerX);
    constrainActorToLobe(this.player, this.playerSide);
    this.recordPlayerPose(deltaTime);
    this.echoes.forEach((echo) => {
      echo.update(deltaTime, this.loopElapsed, (shot) => this.fireEchoBullet(shot));
    });
    this.bullets.forEach((bullet) => bullet.update(deltaTime));

    if (this.player.health > 0) {
      this.enemySpawnTimer -= deltaTime;
      if (this.enemySpawnTimer <= 0 && this.enemies.length < this.maxEnemies) {
        this.spawnEnemy();
        this.enemySpawnTimer = Math.max(0.48, 1.22 - (this.currentLoop - 1) * 0.12);
      }
      const targets = this.getLivingActors();
      this.enemies.forEach((enemy) => {
        enemy.update(deltaTime, targets, (shooter, target) => this.fireEnemyShot(shooter, target));
        const enemySide = enemy.x < ARENA_CENTER_X ? -1 : 1;
        constrainActorToLobe(enemy, enemySide);
      });
      if (this.boss?.active) {
        this.boss.update(deltaTime, targets, (boss) => this.fireBossRing(boss));
      }
      this.handleCollisions();
    }

    this.bullets = this.bullets.filter((bullet) => bullet.active);
    this.enemies = this.enemies.filter((enemy) => enemy.active);

    if (this.state === GAME_STATE.PLAYING && this.player.health <= 0) {
      this.endCurrentLoop("death");
    } else if (this.state === GAME_STATE.PLAYING && this.loopElapsed >= LOOP_DURATION) {
      this.endCurrentLoop("time");
    }

    if (this.state === GAME_STATE.PLAYING) this.input.clearTransient();
  }

  firePlayerBullet(x, y, directionX, directionY) {
    const weaponSnapshot = this.getCurrentWeaponSnapshot();
    const shot = {
      time: this.loopElapsed,
      x: mapCanonicalX(x, this.playerSide),
      y,
      directionX: mapCanonicalDirectionX(directionX, this.playerSide),
      directionY,
      weaponSnapshot: { ...weaponSnapshot },
    };
    this.currentTimeline.shots.push(shot);
    this.bullets.push(
      new Bullet(x, y, directionX, directionY, {
        source: "current",
        ...copyWeapon(weaponSnapshot),
      }),
    );
    this.sound.play("shoot");
  }

  fireEchoBullet(shot) {
    const recorded = shot.weaponSnapshot;
    const weapon = {
      damage: recorded.damage,
      penetration: recorded.echoPenetration ?? recorded.penetration,
      explosionRadius: recorded.echoExplosionRadius ?? recorded.explosionRadius,
      speed: recorded.speed,
    };
    this.bullets.push(
      new Bullet(shot.x, shot.y, shot.directionX, shot.directionY, {
        source: "echo",
        ...weapon,
      }),
    );
    this.sound.play("echoShoot");
  }

  startTimelineRecording() {
    this.currentTimeline = {
      duration: 0,
      endedByDeath: false,
      poses: [
        {
          time: 0,
          x: mapCanonicalX(this.player.x, this.playerSide),
          y: this.player.y,
          aimAngle: mapCanonicalAngle(this.player.aimAngle, this.playerSide),
        },
      ],
      shots: [],
    };
    this.poseAccumulator = 0;
  }

  recordPlayerPose(deltaTime) {
    this.poseAccumulator += deltaTime;
    while (this.poseAccumulator >= POSE_INTERVAL) {
      this.poseAccumulator -= POSE_INTERVAL;
      this.currentTimeline.poses.push({
        time: this.loopElapsed - this.poseAccumulator,
        x: mapCanonicalX(this.player.x, this.playerSide),
        y: this.player.y,
        aimAngle: mapCanonicalAngle(this.player.aimAngle, this.playerSide),
      });
    }
  }

  handleTimelineCrossing(previousPlayerX) {
    const activeEchoes = this.echoes.filter((echo) => echo.active);
    if (activeEchoes.length === 0 || this.timelineSwapCooldown > 0) return;

    const distanceToGate = Math.hypot(
      this.player.x - ARENA_CENTER_X,
      this.player.y - ARENA_CENTER_Y,
    );
    if (distanceToGate > ARENA_GATE_RADIUS) return;

    const crossedFromPresent =
      this.playerSide > 0 && previousPlayerX >= ARENA_CENTER_X && this.player.x < ARENA_CENTER_X;
    const crossedFromPast =
      this.playerSide < 0 && previousPlayerX <= ARENA_CENTER_X && this.player.x > ARENA_CENTER_X;
    if (!crossedFromPresent && !crossedFromPast) return;

    this.playerSide *= -1;
    activeEchoes.forEach((echo) => echo.setSide(-this.playerSide));
    this.timelineSwapCooldown = TIMELINE_SWAP_COOLDOWN;
    this.timelineSwapPulse = 0.7;
    this.timelineSwapCount += 1;
    this.impactShake = Math.max(this.impactShake, 8);
    this.effects.push(
      new ExplosionEffect(ARENA_CENTER_X, ARENA_CENTER_Y, 108, "#bff8ff"),
    );
    this.floatingTexts.push(
      new FloatingText(
        ARENA_CENTER_X,
        ARENA_CENTER_Y - 62,
        "TIMELINE EXCHANGED",
        "#d9fbff",
        19,
      ),
    );
    this.sound.play("swap");
  }

  getCurrentWeaponSnapshot() {
    const explosionRadius = this.progression.explosionLevel > 0
      ? 42 + (this.progression.explosionLevel - 1) * 8
      : 0;
    return {
      damage: 22 * this.progression.damageMultiplier,
      penetration: this.progression.penetration,
      echoPenetration:
        this.progression.penetration + (this.progression.penetration > 0 ? 1 : 0),
      explosionRadius,
      echoExplosionRadius: explosionRadius > 0 ? explosionRadius + 22 : 0,
      speed: BULLET_SPEED,
    };
  }

  endCurrentLoop(reason) {
    if (this.state !== GAME_STATE.PLAYING) return;

    this.resetOrigin = {
      x: this.player.x,
      y: this.player.y,
      aimAngle: this.player.aimAngle,
    };
    this.spawnTimeResetEffects();
    this.currentTimeline.duration = Math.min(this.loopElapsed, LOOP_DURATION);
    this.currentTimeline.endedByDeath = reason === "death";
    this.currentTimeline.poses.push({
      time: this.currentTimeline.duration,
      x: mapCanonicalX(this.player.x, this.playerSide),
      y: this.player.y,
      aimAngle: mapCanonicalAngle(this.player.aimAngle, this.playerSide),
    });
    this.timelines.push(this.currentTimeline);
    this.timelines = this.timelines.slice(-MAX_ECHOES);

    this.state = GAME_STATE.LOOP_COLLAPSE;
    this.stateTimer = RESET_EFFECT_DURATION;
    this.collapseReason = reason;
    this.transitionLabel = "TIME COLLAPSE";
    this.transitionTimer = RESET_EFFECT_DURATION;
    this.input.mouse.shooting = false;
    this.input.clearTransient();
    this.sound.play("collapse");
  }

  enterUpgradeSelection() {
    this.state = GAME_STATE.UPGRADE_SELECT;
    this.transitionTimer = 0;
    this.upgradeOptions = [...UPGRADE_POOL]
      .sort(() => this.nextEnemyRandom() - 0.5)
      .slice(0, 3);
    this.input.clearTransient();
  }

  getUpgradeCardRects() {
    const cardWidth = 248;
    const gap = 22;
    const totalWidth = cardWidth * 3 + gap * 2;
    const startX = (WORLD_WIDTH - totalWidth) / 2;
    return [0, 1, 2].map((index) => ({
      x: startX + index * (cardWidth + gap),
      y: 190,
      width: cardWidth,
      height: 190,
    }));
  }

  handleUpgradeSelection() {
    let selectedIndex = -1;
    if (this.input.consumeKey("Digit1")) selectedIndex = 0;
    if (this.input.consumeKey("Digit2")) selectedIndex = 1;
    if (this.input.consumeKey("Digit3")) selectedIndex = 2;

    if (this.input.consumeClick()) {
      const { x, y } = this.input.mouse;
      selectedIndex = this.getUpgradeCardRects().findIndex(
        (card) =>
          x >= card.x && x <= card.x + card.width && y >= card.y && y <= card.y + card.height,
      );
    }

    if (selectedIndex >= 0 && this.upgradeOptions[selectedIndex]) {
      this.applyUpgrade(this.upgradeOptions[selectedIndex].id);
      this.beginNextLoop();
    }
  }

  applyUpgrade(upgradeId) {
    this.upgradeCounts[upgradeId] += 1;
    if (upgradeId === "damage") this.progression.damageMultiplier *= 1.2;
    if (upgradeId === "fireRate") this.progression.fireRateMultiplier *= 0.85;
    if (upgradeId === "movement") this.progression.movementMultiplier *= 1.12;
    if (upgradeId === "health") this.progression.maxHealthBonus += 25;
    if (upgradeId === "pierce") this.progression.penetration += 1;
    if (upgradeId === "explosion") this.progression.explosionLevel += 1;
    this.sound.play("upgrade");
  }

  beginNextLoop() {
    this.currentLoop += 1;
    this.loopElapsed = 0;
    this.state = GAME_STATE.PLAYING;
    this.transitionLabel = "TIME RESET";
    this.transitionTimer = 0.9;
    this.bullets = [];
    this.enemies = [];
    this.effects = [];
    this.particles = [];
    this.floatingTexts = [];
    this.boss = null;
    this.enemySpawnTimer = 0.45;
    this.resetEnemySequence();
    this.playerSide = 1;
    this.timelineSwapCooldown = 0;
    this.timelineSwapPulse = 0;
    const presentSpawn = getLobeCenter(1);
    this.player.reset(presentSpawn.x + 52, presentSpawn.y, this.progression);
    this.player.aimAngle = Math.PI;
    this.echoes = this.timelines.map(
      (timeline, index) => new EchoActor(timeline, index, -this.playerSide),
    );
    if (this.currentLoop >= 2) this.boss = new Boss(this.nextEntityId());
    this.startTimelineRecording();
    this.combo = 0;
    this.comboTimer = 0;
    this.input.mouse.shooting = false;
    this.input.clearTransient();
  }

  restartGame() {
    this.progression = {
      damageMultiplier: 1,
      fireRateMultiplier: 1,
      movementMultiplier: 1,
      maxHealthBonus: 0,
      penetration: 0,
      explosionLevel: 0,
    };
    this.upgradeCounts = Object.fromEntries(UPGRADE_POOL.map((upgrade) => [upgrade.id, 0]));
    this.timelines = [];
    this.currentLoop = 1;
    this.score = 0;
    this.kills = 0;
    this.entityCounter = 1;
    this.resonanceCount = 0;
    this.timelineSwapCount = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.hitStopTimer = 0;
    this.slowMotionTimer = 0;
    this.impactShake = 0;
    this.maxEnemies = 32;
    this.state = GAME_STATE.PLAYING;
    this.loopElapsed = 0;
    this.transitionLabel = "TIME RESET";
    this.transitionTimer = RESET_EFFECT_DURATION;
    this.bossBreakFlash = 0;
    this.bullets = [];
    this.enemies = [];
    this.echoes = [];
    this.effects = [];
    this.particles = [];
    this.floatingTexts = [];
    this.boss = null;
    this.timeShards = [];
    this.enemySpawnTimer = 0.45;
    this.resetEnemySequence();
    this.playerSide = 1;
    this.timelineSwapCooldown = 0;
    this.timelineSwapPulse = 0;
    const presentSpawn = getLobeCenter(1);
    this.player.reset(presentSpawn.x + 52, presentSpawn.y, this.progression);
    this.player.aimAngle = Math.PI;
    this.startTimelineRecording();
    this.input.mouse.shooting = false;
    this.input.clearTransient();
  }

  nextEntityId() {
    const id = this.entityCounter;
    this.entityCounter += 1;
    return id;
  }

  spawnTimeResetEffects() {
    this.timeShards = [];

    // 横向碎片从旧时间线向两侧撕开，形成轻量级故障视觉。
    for (let index = 0; index < 64; index += 1) {
      const x = Math.random() * WORLD_WIDTH;
      const y = Math.random() * WORLD_HEIGHT;
      const direction = index % 2 === 0 ? -1 : 1;
      this.timeShards.push(new TimeShard(x, y, direction));
    }
  }

  resetEnemySequence() {
    // 每一轮使用同一随机序列，让敌人的出生边缘、位置与速度可以被学习。
    this.enemyRandomState = 0x4e554c4c;
  }

  nextEnemyRandom() {
    this.enemyRandomState =
      (Math.imul(this.enemyRandomState, 1664525) + 1013904223) >>> 0;
    return this.enemyRandomState / 4294967296;
  }

  spawnEnemy() {
    const side = this.nextEnemyRandom() < 0.5 ? -1 : 1;
    const center = getLobeCenter(side);
    const angle = this.nextEnemyRandom() * Math.PI * 2;
    const spawnRadius = 138 + this.nextEnemyRandom() * 28;
    const x = center.x + Math.cos(angle) * spawnRadius;
    const y = center.y + Math.sin(angle) * spawnRadius;

    const speed = 82 + this.nextEnemyRandom() * 28 + (this.currentLoop - 1) * 3;
    const health = 30 + this.currentLoop * 6;
    const typeRoll = this.nextEnemyRandom();
    let type = "chaser";
    if (this.currentLoop >= 2 && typeRoll < 0.2) type = "splitter";
    else if (this.loopElapsed > 6 && typeRoll < 0.48) type = "sniper";
    this.enemies.push(new Enemy(x, y, speed, health, this.nextEntityId(), type));
  }

  fireEnemyShot(enemy, target) {
    const directionX = target.x - enemy.x;
    const directionY = target.y - enemy.y;
    const distance = Math.hypot(directionX, directionY) || 1;
    this.bullets.push(
      new Bullet(enemy.x, enemy.y, directionX / distance, directionY / distance, {
        source: "enemy",
        speed: 390,
        damage: 22,
        radius: 5,
      }),
    );
  }

  spawnMiniEnemies(enemy) {
    for (let index = 0; index < 2; index += 1) {
      const angle = index * Math.PI + this.nextEnemyRandom() * 0.5;
      this.enemies.push(
        new Enemy(
          enemy.x + Math.cos(angle) * 12,
          enemy.y + Math.sin(angle) * 12,
          enemy.speed,
          30 + this.currentLoop * 6,
          this.nextEntityId(),
          "mini",
        ),
      );
    }
  }

  getLivingActors() {
    return [this.player, ...this.echoes].filter(
      (actor) => actor.active !== false && actor.health > 0,
    );
  }

  fireBossRing(boss) {
    const bulletCount = 12;
    for (let index = 0; index < bulletCount; index += 1) {
      const angle = (Math.PI * 2 * index) / bulletCount + this.loopElapsed * 0.25;
      this.bullets.push(
        new Bullet(boss.x, boss.y, Math.cos(angle), Math.sin(angle), {
          source: "boss",
          speed: 185,
          damage: 16,
          radius: 6,
        }),
      );
    }
  }

  handleCollisions() {
    const actorBullets = this.bullets.filter(
      (bullet) => bullet.source === "current" || bullet.source === "echo",
    );
    for (const bullet of actorBullets) {
      if (!bullet.active) continue;

      for (const enemy of this.enemies) {
        if (!enemy.active || !bullet.canHit(enemy.entityId)) continue;
        if (!segmentHitsCircle(bullet.previousX, bullet.previousY, bullet.x, bullet.y, enemy)) {
          continue;
        }

        const resonated = enemy.registerTemporalHit(bullet.source);
        let killed = enemy.takeDamage(bullet.damage);
        this.spawnHitFeedback(enemy.x, enemy.y, bullet.damage, bullet.source);
        if (resonated) killed = this.triggerResonance(enemy, bullet) || killed;
        if (killed) this.awardEnemyKill(enemy);
        if (bullet.explosionRadius > 0) {
          this.applyExplosion(bullet.x, bullet.y, bullet, enemy.entityId);
        }
        bullet.consumeHit(enemy.entityId);
        if (!bullet.active) break;
      }

      if (
        bullet.active &&
        this.boss?.active &&
        bullet.canHit(this.boss.entityId) &&
        segmentHitsCircle(
          bullet.previousX,
          bullet.previousY,
          bullet.x,
          bullet.y,
          this.boss,
        )
      ) {
        const result = this.boss.receiveBullet(bullet);
        if (result.shieldBroken) {
          this.bossBreakFlash = 0.42;
          this.hitStopTimer = 0.09;
          this.slowMotionTimer = 0.5;
          this.impactShake = 14;
          this.effects.push(new ExplosionEffect(this.boss.x, this.boss.y, 125, "#b9f4ff"));
          this.floatingTexts.push(
            new FloatingText(this.boss.x, this.boss.y - 66, "SYNC BREAK", "#b9f4ff", 24),
          );
          this.sound.play("shield");
        } else {
          this.spawnHitFeedback(this.boss.x, this.boss.y, bullet.damage, bullet.source);
        }
        bullet.consumeHit(this.boss.entityId);
        if (result.killed) this.triggerVictory();
      }
    }

    const livingActors = this.getLivingActors();
    const hostileBullets = this.bullets.filter(
      (bullet) => bullet.source === "boss" || bullet.source === "enemy",
    );
    for (const bullet of hostileBullets) {
      if (!bullet.active) continue;
      for (const actor of livingActors) {
        if (actor.active === false || actor.health <= 0) continue;
        if (!bullet.canHit(actor.entityId)) continue;
        if (segmentHitsCircle(bullet.previousX, bullet.previousY, bullet.x, bullet.y, actor)) {
          actor.takeDamage(bullet.damage);
          bullet.consumeHit(actor.entityId);
          break;
        }
      }
    }

    // 敌人接触最近的当前/过去角色后自毁并造成伤害。
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      for (const actor of livingActors) {
        if (actor.active === false || actor.health <= 0) continue;
        if (circlesOverlap(enemy, actor)) {
          actor.takeDamage(20);
          enemy.active = false;
          break;
        }
      }
    }
  }

  applyExplosion(x, y, bullet, excludedEntityId) {
    const color = bullet.source === "echo" ? "#58d9ff" : "#fff2c1";
    this.effects.push(new ExplosionEffect(x, y, bullet.explosionRadius, color));

    for (const enemy of this.enemies) {
      if (!enemy.active || enemy.entityId === excludedEntityId) continue;
      if (Math.hypot(enemy.x - x, enemy.y - y) <= bullet.explosionRadius + enemy.radius) {
        const killed = enemy.takeDamage(bullet.damage * 0.65);
        this.spawnHitFeedback(enemy.x, enemy.y, bullet.damage * 0.65, bullet.source);
        if (killed) this.awardEnemyKill(enemy);
      }
    }
  }

  spawnHitFeedback(x, y, damage, source) {
    const color = source === "echo" ? "#6ee3ff" : "#fff4cf";
    this.floatingTexts.push(new FloatingText(x, y - 18, Math.round(damage), color, 13));
    for (let index = 0; index < 3; index += 1) {
      this.particles.push(new ImpactParticle(x, y, color, 0.75));
    }
    this.hitStopTimer = Math.max(this.hitStopTimer, 0.028);
    this.impactShake = Math.max(this.impactShake, 2.5);
    this.sound.play("hit");
  }

  triggerResonance(enemy, bullet) {
    this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
    this.comboTimer = 3;
    this.resonanceCount += 1;
    this.score += 220 * this.combo;
    this.hitStopTimer = 0.075;
    this.slowMotionTimer = 0.42;
    this.impactShake = 12;
    this.effects.push(new ExplosionEffect(enemy.x, enemy.y, 92, "#bff7ff"));
    this.floatingTexts.push(
      new FloatingText(enemy.x, enemy.y - 38, `RESONANCE ×${this.combo}`, "#a9f3ff", 21),
    );
    for (let index = 0; index < 18; index += 1) {
      const color = index % 2 === 0 ? "#ffffff" : "#4fd8ff";
      this.particles.push(new ImpactParticle(enemy.x, enemy.y, color, 1.5));
    }
    this.sound.play("resonance");

    let killed = false;
    if (enemy.active) killed = enemy.takeDamage(bullet.damage);
    for (const nearby of this.enemies) {
      if (!nearby.active || nearby.entityId === enemy.entityId) continue;
      if (Math.hypot(nearby.x - enemy.x, nearby.y - enemy.y) <= 92 + nearby.radius) {
        const nearbyKilled = nearby.takeDamage(bullet.damage * 0.75);
        this.spawnHitFeedback(nearby.x, nearby.y, bullet.damage * 0.75, "echo");
        if (nearbyKilled) this.awardEnemyKill(nearby);
      }
    }
    return killed;
  }

  awardEnemyKill(enemy) {
    if (enemy.rewarded) return;
    enemy.rewarded = true;
    this.kills += 1;
    this.score += enemy.type === "sniper" ? 180 : enemy.type === "splitter" ? 160 : 100;
    if (enemy.type === "splitter") this.spawnMiniEnemies(enemy);
    const color = enemy.type === "sniper" ? "#ff9ab1" : "#ff496a";
    for (let index = 0; index < 10; index += 1) {
      this.particles.push(new ImpactParticle(enemy.x, enemy.y, color, 1.2));
    }
    this.sound.play("death");
  }

  triggerVictory() {
    if (this.state === GAME_STATE.VICTORY) return;
    this.score += 5000 + Math.round((LOOP_DURATION - this.loopElapsed) * 25);
    this.state = GAME_STATE.VICTORY;
    this.input.mouse.shooting = false;
    this.input.clearTransient();
    this.sound.play("victory");
  }

  draw() {
    const context = this.context;
    context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // 只震动画面中的世界，准星与 UI 保持稳定可读。
    const resetStrength = this.transitionTimer / RESET_EFFECT_DURATION;
    const shake = (this.transitionTimer > 0 ? resetStrength * 6 : 0) + this.impactShake;
    context.save();
    context.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    this.drawBackground(context);
    this.drawTemporalGhost(context);
    this.echoes.forEach((echo) => echo.draw(context));
    this.bullets.forEach((bullet) => bullet.draw(context));
    this.enemies.forEach((enemy) => enemy.draw(context));
    this.boss?.draw(context);
    this.player.draw(context);
    this.effects.forEach((effect) => effect.draw(context));
    this.particles.forEach((particle) => particle.draw(context));
    this.floatingTexts.forEach((textEffect) => textEffect.draw(context));
    this.timeShards.forEach((shard) => shard.draw(context));
    context.restore();

    if (this.state === GAME_STATE.PLAYING) this.drawCrosshair(context);
    if (this.state !== GAME_STATE.TITLE) this.drawStatus(context);
    this.drawLoopWarning(context);
    this.drawLoopTransition(context);
    if (this.state === GAME_STATE.UPGRADE_SELECT) this.drawUpgradeSelection(context);
    if (this.state === GAME_STATE.VICTORY) this.drawVictory(context);
    if (this.state === GAME_STATE.TITLE) this.drawTitle(context);
    if (this.bossBreakFlash > 0) {
      context.save();
      context.fillStyle = `rgba(205, 247, 255, ${this.bossBreakFlash * 0.9})`;
      context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      context.restore();
    }
  }

  drawBackground(context) {
    context.fillStyle = "#070d19";
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.drawInfinityArena(context);

    const remainingTime = LOOP_DURATION - this.loopElapsed;
    const warningStrength = Math.max(0, 1 - remainingTime / LOOP_WARNING_TIME);
    const pulse = 0.5 + Math.sin(this.loopElapsed * 8) * 0.5;

    // 临近重置时网格逐渐增强并向下扫描。
    context.strokeStyle = `rgba(62, 174, 211, ${0.08 + warningStrength * pulse * 0.1})`;
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 0; x <= WORLD_WIDTH; x += 40) {
      context.moveTo(x, 0);
      context.lineTo(x, WORLD_HEIGHT);
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 40) {
      context.moveTo(0, y);
      context.lineTo(WORLD_WIDTH, y);
    }
    context.stroke();

    const scanY = (this.loopElapsed * 95) % WORLD_HEIGHT;
    context.fillStyle = `rgba(75, 213, 255, ${0.025 + warningStrength * 0.08})`;
    context.fillRect(0, scanY, WORLD_WIDTH, 2 + warningStrength * 3);
  }

  drawInfinityArena(context) {
    const presentSide = this.playerSide;
    const echoReady = this.echoes.some((echo) => echo.active);

    [-1, 1].forEach((side) => {
      const center = getLobeCenter(side);
      const isPresent = side === presentSide;
      context.save();
      context.beginPath();
      context.arc(center.x, center.y, ARENA_RADIUS, 0, Math.PI * 2);
      context.fillStyle = isPresent ? "rgba(218, 249, 255, 0.045)" : "rgba(42, 199, 255, 0.07)";
      context.fill();
      context.strokeStyle = isPresent ? "rgba(224, 250, 255, 0.52)" : "rgba(64, 211, 255, 0.48)";
      context.lineWidth = 4;
      context.shadowColor = isPresent ? "#d8f9ff" : "#2dd2ff";
      context.shadowBlur = 18;
      context.stroke();

      context.shadowBlur = 0;
      context.lineWidth = 1;
      context.strokeStyle = isPresent ? "rgba(230, 252, 255, 0.16)" : "rgba(79, 216, 255, 0.18)";
      context.beginPath();
      context.arc(center.x, center.y, ARENA_RADIUS - 18, 0, Math.PI * 2);
      context.stroke();

      context.textAlign = "center";
      context.font = 'bold 12px "Segoe UI", sans-serif';
      context.fillStyle = isPresent ? "rgba(237, 253, 255, 0.72)" : "rgba(92, 222, 255, 0.7)";
      context.fillText(isPresent ? "NOW // CURRENT" : "PAST // ECHO", center.x, 112);
      context.restore();
    });

    context.save();
    const gatePulse = 0.72 + Math.sin(this.loopElapsed * 5) * 0.22;
    context.translate(ARENA_CENTER_X, ARENA_CENTER_Y);
    context.rotate(Math.PI / 4);
    context.fillStyle = echoReady ? "rgba(194, 248, 255, 0.14)" : "rgba(86, 112, 122, 0.12)";
    context.strokeStyle = echoReady
      ? `rgba(201, 250, 255, ${gatePulse})`
      : "rgba(112, 139, 148, 0.38)";
    context.lineWidth = 3;
    context.shadowColor = echoReady ? "#99efff" : "transparent";
    context.shadowBlur = echoReady ? 22 : 0;
    context.fillRect(-25, -25, 50, 50);
    context.strokeRect(-25, -25, 50, 50);
    context.restore();

    context.save();
    context.textAlign = "center";
    context.font = 'bold 10px "Segoe UI", sans-serif';
    context.fillStyle = echoReady ? "rgba(211, 250, 255, 0.76)" : "rgba(120, 148, 157, 0.65)";
    const gateText = echoReady
      ? this.timelineSwapCooldown > 0
        ? "TIMELINE STABILIZING"
        : "CROSS TO EXCHANGE"
      : "ECHO REQUIRED";
    context.fillText(gateText, ARENA_CENTER_X, ARENA_CENTER_Y + 61);
    context.restore();

    if (this.timelineSwapPulse > 0) {
      const progress = 1 - this.timelineSwapPulse / 0.7;
      context.save();
      context.globalAlpha = this.timelineSwapPulse / 0.7;
      context.strokeStyle = "#d4fbff";
      context.lineWidth = 4;
      context.beginPath();
      context.arc(ARENA_CENTER_X, ARENA_CENTER_Y, 38 + progress * 145, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  drawTemporalGhost(context) {
    if (this.transitionTimer <= 0) return;

    const fade = this.transitionTimer / RESET_EFFECT_DURATION;
    const expansion = (1 - fade) * 105;
    context.save();
    context.translate(this.resetOrigin.x, this.resetOrigin.y);
    context.rotate(this.resetOrigin.aimAngle);
    context.globalAlpha = fade * 0.42;
    context.strokeStyle = "#75deff";
    context.lineWidth = 3;
    context.strokeRect(7, -5, 24, 10);
    context.beginPath();
    context.arc(0, 0, 18, 0, Math.PI * 2);
    context.stroke();
    context.restore();

    // 旧位置向外扩散的同心波纹表现时间线断裂。
    context.save();
    context.globalAlpha = fade * 0.55;
    context.strokeStyle = "#55d6ff";
    for (let ring = 0; ring < 3; ring += 1) {
      context.lineWidth = 2 - ring * 0.45;
      context.beginPath();
      context.arc(
        this.resetOrigin.x,
        this.resetOrigin.y,
        26 + expansion + ring * 18,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }
    context.restore();
  }

  drawCrosshair(context) {
    const { x, y } = this.input.mouse;
    context.save();
    context.strokeStyle = "rgba(140, 235, 255, 0.75)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 9, 0, Math.PI * 2);
    context.moveTo(x - 14, y);
    context.lineTo(x - 5, y);
    context.moveTo(x + 5, y);
    context.lineTo(x + 14, y);
    context.moveTo(x, y - 14);
    context.lineTo(x, y - 5);
    context.moveTo(x, y + 5);
    context.lineTo(x, y + 14);
    context.stroke();
    context.restore();
  }

  drawStatus(context) {
    context.save();
    const remainingTime = Math.max(0, LOOP_DURATION - this.loopElapsed);
    const loopProgress = Math.min(1, this.loopElapsed / LOOP_DURATION);
    context.font = 'bold 16px "Segoe UI", sans-serif';
    context.fillStyle = "#dff8ff";
    context.fillText(`HP  ${Math.ceil(this.player.health)} / ${this.player.maxHealth}`, 18, 28);
    context.fillText(`SCORE  ${this.score}`, 18, 53);

    context.textAlign = "right";
    context.fillStyle = "#9be8ff";
    context.fillText(`LOOP  ${this.currentLoop}`, WORLD_WIDTH - 18, 28);
    context.fillStyle = remainingTime <= LOOP_WARNING_TIME ? "#ff7890" : "#9be8ff";
    context.fillText(`TIME  ${remainingTime.toFixed(1)}`, WORLD_WIDTH - 18, 53);
    context.font = '12px "Segoe UI", sans-serif';
    context.fillStyle = "rgba(127, 210, 239, 0.72)";
    const livingEchoes = this.echoes.filter((echo) => echo.active).length;
    context.fillText(`ECHOES  ${livingEchoes} / ${this.echoes.length}`, WORLD_WIDTH - 18, 72);
    context.textAlign = "left";

    if (this.combo > 0 && this.comboTimer > 0) {
      context.textAlign = "center";
      context.font = 'bold 16px "Segoe UI", sans-serif';
      context.fillStyle = "#a9f3ff";
      context.shadowColor = "#46d9ff";
      context.shadowBlur = 12;
      context.fillText(`RESONANCE CHAIN ×${this.combo}`, WORLD_WIDTH / 2, 92);
      context.shadowBlur = 0;
      context.textAlign = "left";
    }

    context.textAlign = "center";
    context.font = 'bold 11px "Segoe UI", sans-serif';
    context.fillStyle = this.playerSide > 0 ? "#e8fbff" : "#63ddff";
    context.fillText(
      `CURRENT ${this.playerSide > 0 ? "RIGHT" : "LEFT"}  //  TIMELINE SWAPS ${this.timelineSwapCount}`,
      WORLD_WIDTH / 2,
      WORLD_HEIGHT - 18,
    );
    context.textAlign = "left";

    // 顶部时间轴让玩家无需阅读数字也能判断距离重置还有多久。
    const timelineX = 270;
    const timelineY = 20;
    const timelineWidth = 420;
    context.fillStyle = "rgba(111, 205, 234, 0.13)";
    context.fillRect(timelineX, timelineY, timelineWidth, 5);
    context.fillStyle = remainingTime <= LOOP_WARNING_TIME ? "#ff496a" : "#50d6ff";
    context.fillRect(timelineX, timelineY, timelineWidth * loopProgress, 5);
    for (let marker = 0; marker <= 6; marker += 1) {
      context.fillStyle = "rgba(213, 247, 255, 0.38)";
      context.fillRect(timelineX + (timelineWidth / 6) * marker, timelineY - 3, 1, 11);
    }

    // 简单血条用于确认接触碰撞结果，正式 UI 留到第四阶段。
    context.fillStyle = "rgba(255, 255, 255, 0.12)";
    context.fillRect(18, 64, 160, 8);
    context.fillStyle = this.player.health > 30 ? "#42dbff" : "#ff3d60";
    context.fillRect(18, 64, 160 * (this.player.health / this.player.maxHealth), 8);

    // Echo 生命状态紧凑排列在左上角血条下方。
    this.echoes.forEach((echo, index) => {
      const y = 84 + index * 13;
      context.font = '10px "Segoe UI", sans-serif';
      context.fillStyle = echo.active ? "#67ddff" : "rgba(103,221,255,0.3)";
      context.fillText(`E${index + 1}`, 18, y + 7);
      context.fillStyle = "rgba(103,221,255,0.12)";
      context.fillRect(40, y, 88, 6);
      context.fillStyle = echo.active ? "#45cfff" : "#284653";
      context.fillRect(40, y, 88 * (echo.health / echo.maxHealth), 6);
    });

    const activeUpgrades = UPGRADE_POOL
      .filter((upgrade) => this.upgradeCounts[upgrade.id] > 0)
      .map((upgrade) => `${upgrade.title}×${this.upgradeCounts[upgrade.id]}`);
    if (activeUpgrades.length > 0) {
      context.font = '11px "Segoe UI", sans-serif';
      context.fillStyle = "rgba(190, 231, 241, 0.7)";
      context.fillText(activeUpgrades.join("  "), 18, WORLD_HEIGHT - 18);
    }

    if (this.boss?.active) {
      const bossBarWidth = 360;
      const bossBarX = (WORLD_WIDTH - bossBarWidth) / 2;
      context.fillStyle = "rgba(255,255,255,0.12)";
      context.fillRect(bossBarX, 43, bossBarWidth, 10);
      context.fillStyle = "#ff3f62";
      context.fillRect(bossBarX, 43, bossBarWidth * (this.boss.health / this.boss.maxHealth), 10);
      context.textAlign = "center";
      context.font = 'bold 11px "Segoe UI", sans-serif';
      context.fillStyle = this.boss.shieldBreakTimer > 0 ? "#e9fbff" : "#cb8cff";
      const shieldText = this.boss.shieldBreakTimer > 0
        ? `TEMPORAL SHIELD BROKEN ${this.boss.shieldBreakTimer.toFixed(1)}s`
        : `SYNC SHIELD  NOW:${this.boss.presentMarkTimer > 0 ? "✓" : "○"}  PAST:${this.boss.pastMarkTimer > 0 ? "✓" : "○"}`;
      context.fillText(shieldText, WORLD_WIDTH / 2, 68);
    }

    context.restore();
  }

  drawLoopWarning(context) {
    const remainingTime = LOOP_DURATION - this.loopElapsed;
    if (
      this.state !== GAME_STATE.PLAYING ||
      remainingTime > LOOP_WARNING_TIME ||
      this.transitionTimer > 0
    ) return;

    const urgency = 1 - remainingTime / LOOP_WARNING_TIME;
    const pulse = 0.45 + Math.sin(this.loopElapsed * 12) * 0.25;
    context.save();
    context.strokeStyle = `rgba(255, 55, 91, ${urgency * pulse})`;
    context.lineWidth = 5 + urgency * 4;
    context.strokeRect(5, 5, WORLD_WIDTH - 10, WORLD_HEIGHT - 10);

    context.textAlign = "center";
    context.font = 'bold 13px "Segoe UI", sans-serif';
    context.fillStyle = `rgba(255, 126, 148, ${0.5 + urgency * 0.5})`;
    context.fillText("TEMPORAL COLLAPSE", WORLD_WIDTH / 2, 49);

    if (remainingTime <= 3) {
      context.font = 'bold 64px "Segoe UI", sans-serif';
      context.globalAlpha = 0.12 + pulse * 0.16;
      context.fillStyle = "#ff5472";
      context.fillText(Math.max(1, Math.ceil(remainingTime)), WORLD_WIDTH / 2, 112);
    }
    context.restore();
  }

  drawLoopTransition(context) {
    if (this.transitionTimer <= 0) return;

    const strength = this.transitionTimer / RESET_EFFECT_DURATION;
    const progress = 1 - strength;
    const flash = Math.max(0, 1 - progress / 0.18);
    context.save();
    context.fillStyle = `rgba(220, 250, 255, ${flash * 0.72})`;
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // 少量横向扫描条产生“时间画面被重新同步”的感觉。
    for (let band = 0; band < 9; band += 1) {
      const bandY = (band * 71 + this.currentLoop * 29) % WORLD_HEIGHT;
      const offset = Math.sin(progress * 70 + band) * 30 * strength;
      context.fillStyle = `rgba(82, 211, 255, ${strength * 0.09})`;
      context.fillRect(offset, bandY, WORLD_WIDTH, 2 + (band % 3));
    }

    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = 'bold 46px "Segoe UI", sans-serif';
    context.fillStyle = `rgba(218, 249, 255, ${Math.min(1, strength * 1.7)})`;
    context.shadowColor = "#38caff";
    context.shadowBlur = 26;
    context.fillText(this.transitionLabel, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 8);
    context.shadowBlur = 0;
    context.font = 'bold 14px "Segoe UI", sans-serif';
    const transitionDetail = this.state === GAME_STATE.LOOP_COLLAPSE
      ? this.collapseReason === "death"
        ? "CURRENT SELF LOST // TIMELINE SAVED"
        : `${LOOP_DURATION} SECONDS CAPTURED // TIMELINE SAVED`
      : `LOOP ${this.currentLoop}  //  ${this.echoes.length} ECHOES SYNCHRONIZED`;
    context.fillText(
      transitionDetail,
      WORLD_WIDTH / 2,
      WORLD_HEIGHT / 2 + 34,
    );
    context.restore();
  }

  drawUpgradeSelection(context) {
    context.save();
    context.fillStyle = "rgba(3, 8, 18, 0.9)";
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    context.textAlign = "center";
    context.font = 'bold 34px "Segoe UI", sans-serif';
    context.fillStyle = "#c9f5ff";
    context.shadowColor = "#3ed1ff";
    context.shadowBlur = 16;
    context.fillText("CHOOSE A MEMORY", WORLD_WIDTH / 2, 104);
    context.shadowBlur = 0;
    context.font = '13px "Segoe UI", sans-serif';
    context.fillStyle = "#789ba7";
    context.fillText("选择一项永久强化，然后进入下一条时间线", WORLD_WIDTH / 2, 132);

    const cards = this.getUpgradeCardRects();
    cards.forEach((card, index) => {
      const upgrade = this.upgradeOptions[index];
      if (!upgrade) return;
      const hovered =
        this.input.mouse.x >= card.x &&
        this.input.mouse.x <= card.x + card.width &&
        this.input.mouse.y >= card.y &&
        this.input.mouse.y <= card.y + card.height;
      context.fillStyle = hovered ? "rgba(32, 122, 156, 0.45)" : "rgba(14, 48, 67, 0.72)";
      context.fillRect(card.x, card.y, card.width, card.height);
      context.strokeStyle = hovered ? "#8ceaff" : "rgba(81, 203, 239, 0.45)";
      context.lineWidth = hovered ? 3 : 1;
      context.strokeRect(card.x, card.y, card.width, card.height);

      context.textAlign = "left";
      context.font = 'bold 16px "Segoe UI", sans-serif';
      context.fillStyle = "#65dfff";
      context.fillText(`0${index + 1}`, card.x + 18, card.y + 30);
      context.font = 'bold 23px "Segoe UI", sans-serif';
      context.fillStyle = "#eefcff";
      context.fillText(upgrade.title, card.x + 18, card.y + 79);
      context.font = '14px "Segoe UI", sans-serif';
      context.fillStyle = "#a5c5cf";
      context.fillText(upgrade.description, card.x + 18, card.y + 118);
      context.font = '12px "Segoe UI", sans-serif';
      context.fillStyle = "#638b98";
      context.fillText(`当前层数：${this.upgradeCounts[upgrade.id]}`, card.x + 18, card.y + 160);
    });

    context.textAlign = "center";
    context.font = '12px "Segoe UI", sans-serif';
    context.fillStyle = "rgba(170, 221, 235, 0.68)";
    context.fillText("点击卡片，或按数字键 1 / 2 / 3", WORLD_WIDTH / 2, 430);
    context.restore();
  }

  drawTitle(context) {
    context.save();
    context.fillStyle = "rgba(2, 7, 16, 0.9)";
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    context.textAlign = "center";
    context.shadowColor = "#3fd5ff";
    context.shadowBlur = 28;
    context.font = 'bold 58px "Segoe UI", sans-serif';
    context.fillStyle = "#e6fbff";
    context.fillText("ECHO ∞", WORLD_WIDTH / 2, 88);
    context.shadowBlur = 0;
    context.font = 'bold 15px "Segoe UI", sans-serif';
    context.fillStyle = "#63dfff";
    context.fillText("TWIN TIMELINES // ONE CROSSING", WORLD_WIDTH / 2, 117);

    const panels = [
      { x: 90, title: "01  RECORD", detail: "右环战斗 30 秒\n记录移动与射击" },
      { x: 370, title: "02  MIRROR", detail: "Echo 在另一时间环\n镜像重演行动" },
      { x: 650, title: "03  EXCHANGE", detail: "穿越中心交换时间环\n同步击破交点 Boss" },
    ];
    panels.forEach((panel, index) => {
      context.fillStyle = "rgba(15, 58, 78, 0.58)";
      context.fillRect(panel.x, 170, 220, 190);
      context.strokeStyle = index === 2 ? "#b9f5ff" : "rgba(75, 207, 244, 0.45)";
      context.strokeRect(panel.x, 170, 220, 190);
      context.textAlign = "left";
      context.font = 'bold 15px "Segoe UI", sans-serif';
      context.fillStyle = "#74e3ff";
      context.fillText(panel.title, panel.x + 18, 200);

      context.save();
      context.translate(panel.x + 110, 250);
      if (index === 0) {
        context.fillStyle = "#20b8e9";
        context.beginPath();
        context.arc(0, 0, 15, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(103,220,255,0.5)";
        context.beginPath();
        context.moveTo(-66, 32);
        context.lineTo(66, 32);
        context.stroke();
      } else if (index === 1) {
        [-32, 32].forEach((offset, actorIndex) => {
          context.globalAlpha = actorIndex === 0 ? 0.45 : 1;
          context.fillStyle = actorIndex === 0 ? "#65dcff" : "#ffffff";
          context.beginPath();
          context.arc(offset, 0, 15, 0, Math.PI * 2);
          context.fill();
        });
      } else {
        context.strokeStyle = "#ffffff";
        context.beginPath();
        context.moveTo(-70, 0);
        context.lineTo(-8, 0);
        context.stroke();
        context.strokeStyle = "#55dcff";
        context.beginPath();
        context.moveTo(70, 0);
        context.lineTo(8, 0);
        context.stroke();
        context.strokeStyle = "#bff7ff";
        context.lineWidth = 3;
        context.beginPath();
        context.arc(0, 0, 24, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();

      context.textAlign = "center";
      context.font = '13px "Segoe UI", sans-serif';
      context.fillStyle = "#a8c7d0";
      const detailLines = panel.detail.split("\n");
      context.fillText(detailLines[0], panel.x + 110, 315);
      context.fillText(detailLines[1], panel.x + 110, 336);
    });

    const pulse = 0.65 + Math.sin(performance.now() * 0.004) * 0.25;
    context.textAlign = "center";
    context.globalAlpha = pulse;
    context.font = 'bold 17px "Segoe UI", sans-serif';
    context.fillStyle = "#ffffff";
    context.fillText("点击画面或按 ENTER 开始", WORLD_WIDTH / 2, 421);
    context.globalAlpha = 1;
    context.font = '12px "Segoe UI", sans-serif';
    context.fillStyle = "#668994";
    context.fillText("WASD 移动  //  鼠标瞄准射击  //  穿越中心交换时间环", WORLD_WIDTH / 2, 459);
    context.restore();
  }

  calculateRank() {
    if (this.resonanceCount >= 8 || this.score >= 9000) return "S";
    if (this.resonanceCount >= 5 || this.score >= 6500) return "A";
    if (this.resonanceCount >= 2 || this.score >= 4500) return "B";
    return "C";
  }

  drawVictory(context) {
    context.save();
    context.fillStyle = "rgba(2, 9, 17, 0.88)";
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    context.textAlign = "center";
    context.shadowColor = "#5de1ff";
    context.shadowBlur = 28;
    context.font = 'bold 42px "Segoe UI", sans-serif';
    context.fillStyle = "#e5fbff";
    context.fillText("TIMELINE RESTORED", WORLD_WIDTH / 2, 142);
    context.shadowBlur = 0;
    context.font = 'bold 92px "Segoe UI", sans-serif';
    context.fillStyle = "#78dfff";
    context.fillText(this.calculateRank(), WORLD_WIDTH / 2, 252);
    context.font = '14px "Segoe UI", sans-serif';
    context.fillStyle = "#a2dce9";
    context.fillText("TEMPORAL RANK", WORLD_WIDTH / 2, 278);
    context.font = 'bold 24px "Segoe UI", sans-serif';
    context.fillStyle = "#ffffff";
    context.fillText(`FINAL SCORE  ${this.score}`, WORLD_WIDTH / 2, 326);
    context.font = '13px "Segoe UI", sans-serif';
    context.fillStyle = "#7797a1";
    context.fillText(
      `LOOP ${this.currentLoop}  //  SWAPS ${this.timelineSwapCount}  //  RESONANCE ${this.resonanceCount}`,
      WORLD_WIDTH / 2,
      358,
    );
    context.fillText("按 R 重新开始", WORLD_WIDTH / 2, 414);
    context.restore();
  }
}

const canvas = document.getElementById("gameCanvas");
const game = new Game(canvas);
game.start();

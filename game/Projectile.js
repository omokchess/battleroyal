/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class Projectile {
  constructor(id, ownerId, x, y, angle, speed, maxRange, damage, kind = 'arrow') {
    this.id = id;
    this.ownerId = ownerId;
    this.x = x;
    this.y = y;
    this.startX = x;
    this.startY = y;

    // Deconstruct velocity using trig
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.angle = angle; // explicit heading (kept even when velocity is zero)

    this.speed = speed;
    this.maxRange = maxRange;
    this.damage = damage;
    this.kind = kind; // 'arrow' | 'swordwave' | 'thrownspear'
    this.weapon = kind === 'swordwave' ? 'sword' : 'bow';
    this.isDead = false;
    this.radius = 5; // Hit detection radius

    // Skill-projectile runtime fields (set by the host, never serialized).
    this.explosionRadius = 0;
    this.explosionDamage = 0;
    this.bornAt = 0;
    this.phase = 'out';
    this.stuck = false;
    this.hitSet = null;
  }

  // Update projectile coordinates
  update(deltaTime) {
    if (this.isDead) return;

    // Movement
    this.x += this.vx * deltaTime;
    this.y += this.vy * deltaTime;

    if (Number.isFinite(this.maxRange)) {
      const dx = this.x - this.startX;
      const dy = this.y - this.startY;
      const distanceTraveled = Math.sqrt(dx * dx + dy * dy);

      if (distanceTraveled >= this.maxRange) {
        this.isDead = true;
      }
    }
  }

  checkWallCollision(mapWidth, mapHeight) {
    if (this.isDead) return false;

    if (
      this.x <= this.radius ||
      this.x >= mapWidth - this.radius ||
      this.y <= this.radius ||
      this.y >= mapHeight - this.radius
    ) {
      this.x = Math.max(this.radius, Math.min(mapWidth - this.radius, this.x));
      this.y = Math.max(this.radius, Math.min(mapHeight - this.radius, this.y));
      this.isDead = true;
      this.hitWall = true;
      return true;
    }

    return false;
  }

  /**
   * Serialize state representation
   */
  serialize() {
    return {
      id: this.id,
      ownerId: this.ownerId,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      angle: this.angle,
      speed: this.speed,
      maxRange: Number.isFinite(this.maxRange) ? this.maxRange : null,
      damage: this.damage,
      kind: this.kind,
      weapon: this.weapon,
      wsImageId: this.wsImageId || null,
      wsScale: this.wsScale || 1,
      piercing: !!this.piercing,
      isDead: this.isDead
    };
  }
}

import type { EventBus, GameEvents } from '../../core/events';
import type { InputSystem } from '../../core/input/input-system';
import { wrapAngle } from '../../core/math';
import { Group, interactionGroups } from '../../physics/collision-groups';
import { createRayHit, type PhysicsWorld } from '../../physics/physics-world';
import {
  CharacterMotor,
  emptyCommand,
  MOTOR,
  type MotorCommand,
  type MotorEnvironment,
  type MoveSpeed,
} from '../controller/character-motor';
import {
  applyDamage,
  canSprint,
  createVitals,
  fallDamage,
  revive,
  updateStamina,
  type Vitals,
} from '../stats/vitals';

export const PLAYER = {
  /** Stamina drained per second while sprinting / fast swimming. */
  sprintDrain: 13,
  swimDrain: 9,
  /** Seconds on the FLATLINED screen before respawning. */
  respawnDelay: 4.5,
  /** Below this height the player has fallen out of the world. */
  killPlaneY: -60,
  /** Waiting for streamed ground colliders before the player is released (seconds). */
  placementTimeout: 12,
  /**
   * Minimum wait before deciding "no ground here, it is open water": colliders created since the
   * last physics step are not visible to ray casts until the next one.
   */
  placementSettle: 0.1,
} as const;

/** Movement input in camera space → world-space direction on the ground plane. */
export function cameraRelativeMove(
  moveX: number,
  moveY: number,
  cameraYaw: number,
  out: { x: number; z: number },
): void {
  // Camera forward (yaw 0 = −Z) and right on the ground plane.
  const fx = -Math.sin(cameraYaw);
  const fz = -Math.cos(cameraYaw);
  const rx = Math.cos(cameraYaw);
  const rz = -Math.sin(cameraYaw);
  out.x = rx * moveX + fx * moveY;
  out.z = rz * moveX + fz * moveY;
}

/** Character yaw (0 = facing +Z) that faces along the camera's view direction. */
export function yawFacingCamera(cameraYaw: number): number {
  return wrapAngle(cameraYaw + Math.PI);
}

export interface PlayerView {
  /** Camera yaw/pitch (radians), read when building movement commands. */
  readonly yaw: number;
  readonly pitch: number;
}

interface Placement {
  x: number;
  z: number;
  /** Ray start height (searching downward) — the target surface must be below it. */
  fromY: number;
  yaw: number | null;
  waited: number;
}

const GROUND_GROUPS = interactionGroups(0xffff, Group.WORLD | Group.PROP | Group.VEHICLE);

/**
 * The player on foot: turns input into motor commands relative to the camera, runs stamina,
 * applies fall damage, handles death (FLATLINED) and respawn, and places the player safely on
 * streamed ground after spawns and teleports.
 */
export class PlayerCharacter {
  readonly motor: CharacterMotor;
  readonly vitals: Vitals = createVitals();
  /** Disabled while the debug fly camera or a menu has control. */
  controlsEnabled = true;
  aiming = false;
  dead = false;
  /** Seconds since death. */
  deadTime = 0;
  deathCause = '';
  deaths = 0;
  /** True until the pending placement found ground. */
  placing = false;
  private placement: Placement | null = null;
  private lastLandings = 0;
  private lastWaterEntries = 0;
  private readonly cmd: MotorCommand = emptyCommand();
  private readonly move = { x: 0, z: 0 };
  private readonly hit = createRayHit();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly env: MotorEnvironment,
    private readonly input: InputSystem,
    private readonly bus: EventBus<GameEvents>,
    private readonly view: PlayerView,
    x: number,
    y: number,
    z: number,
    private readonly respawnPoint: () => { x: number; y: number; z: number; yaw: number },
  ) {
    this.motor = new CharacterMotor(physics, env, x, y, z);
  }

  get alive(): boolean {
    return !this.dead;
  }

  /**
   * Moves the player to (x, z) on the first surface below `fromY` once its collider exists
   * (streaming may still be loading it). Open water counts as a surface.
   */
  placeAt(x: number, z: number, fromY: number, yaw: number | null = null): void {
    this.placement = { x, z, fromY, yaw, waited: 0 };
    this.placing = true;
    this.motor.teleport(x, fromY, z);
  }

  damage(amount: number, cause: string, bypassArmor = false): void {
    if (this.dead || amount <= 0) return;
    const result = applyDamage(this.vitals, amount, bypassArmor);
    if (result.dealt + result.absorbed <= 0) return;
    this.bus.emit('player:damaged', {
      amount: result.dealt + result.absorbed,
      health: this.vitals.health,
      armor: this.vitals.armor,
      cause,
    });
    if (result.died) this.kill(cause);
  }

  kill(cause: string): void {
    if (this.dead) return;
    this.vitals.health = 0;
    this.dead = true;
    this.deadTime = 0;
    this.deathCause = cause;
    this.deaths++;
    this.aiming = false;
    this.motor.kill();
    const p = this.motor.position;
    this.bus.emit('player:died', { cause, x: p.x, y: p.y, z: p.z });
  }

  respawn(): void {
    const at = this.respawnPoint();
    revive(this.vitals);
    this.dead = false;
    this.deadTime = 0;
    this.motor.revive();
    this.placeAt(at.x, at.z, at.y + 2, at.yaw);
    this.bus.emit('player:respawned', { x: at.x, y: at.y, z: at.z });
  }

  /** One fixed step. */
  step(dt: number): void {
    if (this.placing) {
      this.tryPlace(dt);
      if (this.placing) return;
    }
    const motor = this.motor;
    const cmd = this.cmd;
    const input = this.input;
    cmd.moveX = 0;
    cmd.moveZ = 0;
    cmd.jump = false;
    cmd.crouchToggle = false;
    cmd.faceYaw = null;
    cmd.speed = 'run';

    if (this.dead) {
      this.deadTime += dt;
      if (this.deadTime >= PLAYER.respawnDelay) {
        this.respawn();
        return;
      }
    } else if (this.controlsEnabled) {
      cameraRelativeMove(input.axis('moveX'), input.axis('moveY'), this.view.yaw, this.move);
      cmd.moveX = this.move.x;
      cmd.moveZ = this.move.z;
      cmd.jump = input.pressed('jump');
      cmd.crouchToggle = input.pressed('crouch');
      this.aiming = input.down('aim') && motor.mode === 'ground';
      if (this.aiming) cmd.faceYaw = yawFacingCamera(this.view.yaw);
      cmd.speed = this.chooseSpeed(input.down('sprint'), input.down('walk'));
    } else {
      this.aiming = false;
    }

    motor.step(cmd, dt);
    this.updateStamina(cmd.speed, dt);
    this.checkLanding();
    if (motor.waterEntries !== this.lastWaterEntries) {
      this.lastWaterEntries = motor.waterEntries;
      const p = motor.position;
      this.bus.emit('player:enteredWater', { x: p.x, z: p.z });
    }
    if (!this.dead && motor.position.y < PLAYER.killPlaneY) this.kill('fell');
  }

  private chooseSpeed(sprintHeld: boolean, walkHeld: boolean): MoveSpeed {
    if (this.aiming || walkHeld) return 'walk';
    if (sprintHeld && canSprint(this.vitals) && (this.motor.mode === 'ground' || this.motor.mode === 'swim'))
      return 'sprint';
    return 'run';
  }

  private updateStamina(speed: MoveSpeed, dt: number): void {
    const motor = this.motor;
    let drain = 0;
    if (speed === 'sprint' && motor.speed > 1)
      drain = motor.mode === 'swim' ? PLAYER.swimDrain : PLAYER.sprintDrain;
    updateStamina(this.vitals, dt, drain);
  }

  private checkLanding(): void {
    const motor = this.motor;
    if (motor.landings === this.lastLandings) return;
    this.lastLandings = motor.landings;
    const damage = fallDamage(motor.lastImpactSpeed, MOTOR.gravity);
    this.bus.emit('player:landed', { impactSpeed: motor.lastImpactSpeed, damage });
    // Armour does not soften falls (a lethal height must stay lethal).
    if (damage > 0) this.damage(damage, 'fall', true);
  }

  private tryPlace(dt: number): void {
    const p = this.placement;
    if (!p) {
      this.placing = false;
      return;
    }
    p.waited += dt;
    const range = p.fromY - this.env.waterLevel + 40;
    const floatY = this.env.waterLevel - MOTOR.floatDepth;
    const settled = p.waited >= PLAYER.placementSettle;
    const hit = this.physics.castRay(
      p.x,
      p.fromY,
      p.z,
      0,
      -1,
      0,
      range,
      this.hit,
      GROUND_GROUPS,
      this.motor.body,
    );
    let y: number | null = null;
    if (hit && this.hit.y >= floatY)
      y = this.hit.y; // dry ground (or a deck) above the water
    else if (settled && this.env.isWater(p.x, p.z))
      y = floatY; // open water (maybe over the sea floor)
    else if (settled && hit)
      y = this.hit.y; // below sea level but dry (tunnel)
    else if (p.waited > PLAYER.placementTimeout) y = floatY;
    if (y === null) {
      this.motor.teleport(p.x, p.fromY, p.z);
      return;
    }
    this.motor.teleport(p.x, y + 0.02, p.z);
    if (p.yaw !== null) this.motor.yaw = p.yaw;
    this.placement = null;
    this.placing = false;
    this.lastLandings = this.motor.landings;
  }
}

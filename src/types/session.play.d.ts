// C:\Users\larho\suka-smart-assistant\src\types\session.play.d.ts
// Ambient TypeScript definitions for SSA session.play envelopes & payloads.
// These types mirror the JSON schema in `src/contracts/session.play.contract.json`
// and are safe to include even in JS projects (no transpile cost).
// -----------------------------------------------------------------------------
// How this fits the pipeline (imports → intelligence → automation → hub?):
// - These types describe the canonical runtime envelopes emitted/consumed by
//   players, automations, timers, and (optionally) hub exporters.
// - Envelope shape is always: { type, ts, source, data } with ISO timestamps.

declare namespace SSA {
  namespace SessionPlay {
    /** Supported SSA execution domains */
    type Domain =
      | "cooking"
      | "cleaning"
      | "garden"
      | "animals"
      | "preservation"
      | "storehouse";

    /** Canonical identifier */
    type ID = string;

    /** Milliseconds (non-negative) */
    type Ms = number;

    /** Envelope discriminator */
    type Type =
      | "session.play.start"
      | "session.play.stop"
      | "session.play.pause"
      | "session.play.resume"
      | "session.play.step.next"
      | "session.play.step.prev"
      | "session.play.step.go"
      | "session.play.announce"
      | "session.play.keepAwake"
      | "session.play.state.sync"
      | "session.play.timer.start"
      | "session.play.timer.pause"
      | "session.play.timer.resume"
      | "session.play.timer.cancel";

    /** Standard event envelope for session.play.* */
    interface Envelope<TData = unknown> {
      /** Event type discriminator */
      type: Type;
      /** ISO-8601 timestamp at emit time */
      ts: string;
      /** Logical emitter (e.g., "pages.cooking.play", "engine.cleaning.session") */
      source: string;
      /** Event-specific payload */
      data: TData;
    }

    /** Common fields present in all data payloads */
    interface CommonFields {
      domain: Domain;
      sessionId: ID;
      /** Optional: the normalized draft id this session originated from */
      draftId?: string;
      /** Optional: room code for remote control or shared playback */
      room?: string;
      /** If true, UIs should redact sensitive content for streaming/recording */
      streamerSafe?: boolean;
      /** Implementation-defined extension bag */
      meta?: Record<string, unknown>;
    }

    // ----------------------------- Data Shapes -----------------------------

    interface StartData extends CommonFields {
      /** Initial step cursor; clamped to [0, stepCount-1] by players */
      startAtStepIndex?: number;
      /** Request a keep-awake lock while playing (platform-best-effort) */
      keepAwake?: boolean;
      /** Optional initial speech synthesis preferences */
      speech?: {
        enabled?: boolean;
        lang?: string;
        voiceHint?: string;
        rate?: number;   // 0.1 .. 3.0
        pitch?: number;  // 0.0 .. 2.0
        volume?: number; // 0.0 .. 1.0
      };
    }

    interface StopData extends CommonFields {
      /** Why playback was stopped */
      reason?: "user" | "completed" | "error" | "navigation" | "remote";
    }

    type PauseResumeData = CommonFields;

    interface StepNextPrevData extends CommonFields {
      /** If true, announce the next step after navigation */
      announce?: boolean;
    }

    interface StepGoData extends CommonFields {
      /** Target step index (>= 0) */
      stepIndex: number;
      /** If true, announce the target step after navigation */
      announce?: boolean;
    }

    interface AnnounceData extends CommonFields {
      /** Plain text to speak/show */
      text: string;
      /** BCP-47 language tag hint (e.g., "en-US") */
      lang?: string;
      /** Optional tag for dedupe/telemetry */
      tag?: string;
    }

    interface KeepAwakeData extends CommonFields {
      /** Turn wake lock on/off */
      on: boolean;
    }

    /** Individual timer runtime snapshot used by state.sync */
    interface TimerState {
      id: ID;
      label: string;
      remainingMs: Ms;
      status: "idle" | "running" | "paused" | "done" | "canceled";
    }

    interface StateSyncData extends CommonFields {
      /** Current cursor */
      stepIndex: number;
      /** Zero or more timer snapshots */
      timerStates?: TimerState[];
    }

    interface TimerStartData extends CommonFields {
      timerId: ID;
      label?: string;
      durationMs: Ms;
      /** If true, beep/notify on completion (notify.js) */
      autobeep?: boolean;
    }

    interface TimerSimpleData extends CommonFields {
      timerId: ID;
    }

    // ---------------------------- Type Mappings ----------------------------

    type DataByType = {
      "session.play.start": StartData;
      "session.play.stop": StopData;
      "session.play.pause": PauseResumeData;
      "session.play.resume": PauseResumeData;

      "session.play.step.next": StepNextPrevData;
      "session.play.step.prev": StepNextPrevData;
      "session.play.step.go": StepGoData;

      "session.play.announce": AnnounceData;
      "session.play.keepAwake": KeepAwakeData;
      "session.play.state.sync": StateSyncData;

      "session.play.timer.start": TimerStartData;
      "session.play.timer.pause": TimerSimpleData;
      "session.play.timer.resume": TimerSimpleData;
      "session.play.timer.cancel": TimerSimpleData;
    };

    /** Envelope narrowed by its `type` discriminator */
    type EnvelopeByType<T extends Type> = Envelope<DataByType[T]>;

    /** Discriminated union of all session.play envelopes */
    type AnyEnvelope = {
      [K in Type]: EnvelopeByType<K>;
    }[Type];

    // -------------------------- Helper Utility Types -----------------------

    /** Extract the payload type for a given session.play type string */
    type PayloadOf<T extends Type> = DataByType[T];

    /** Narrow at callsites when only a subset of types is possible */
    type EnvelopesOf<T extends readonly Type[]> = {
      [K in T[number]]: EnvelopeByType<K>;
    }[T[number]];
  }

  // --------------------- Optional: Light event-bus shape ---------------------
  // If your runtime exposes a window event bus, these help with editor tooling.
  interface SukaEventBusLike {
    emit(payload: SessionPlay.AnyEnvelope): void;
    on?(type: SessionPlay.Type, listener: (payload: SessionPlay.AnyEnvelope) => void): void;
    off?(type: SessionPlay.Type, listener: (payload: SessionPlay.AnyEnvelope) => void): void;
  }
}

// ------------------------- Global Window Augmentation -------------------------
declare global {
  interface Window {
    /** Optional SSA namespace hung off the window by the app at runtime */
    __suka?: {
      eventBus?: SSA.SukaEventBusLike;
    };
  }
}

export {};

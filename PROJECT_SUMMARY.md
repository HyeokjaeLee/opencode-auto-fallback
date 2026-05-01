# opencode-auto-fallback 프로젝트 요약정리

## 프로젝트 개요
**opencode-auto-fallback**는 OpenCode 플랫폼용 플러그인으로, LLM 에러 발생 시 자동으로 대체(fallback) 모델 체인으로 전환하는 기능을 제공합니다. 순수 TypeScript로 작성되었으며, ESM 모듈 방식을 사용하며 빌드 단계 없이 원본 `.ts` 파일을 그대로 배포합니다.

### 주요 기능
1. **이중 계층 에러 분류**
   - 즉시 대체: 인증 오류 (HTTP 401/402/403)
   - 재시도 후 대체: 속도 제한 및 일시적 오류 (SDK의 `isRetryable` 플래그 기반)

2. **대체 체인 시스템**
   - 에이전트별 대체 모델 체인 구성
   - 모델별 쿨다운 관리
   - 지능형 백오프 재시도 (2^n × 2000ms)

3. **대형 컨텍스트 대체 (정확한 구현)**
   - **세션 포킹이 아닌 인플레이스 모델 전환** 사용
   - 상태 기반 컨텍스트 창 관리 (pending → active → summarizing)
   - 자동 컴팩션 제어 및 원본 모덌 복귀
   - `session-fork.ts`는 레거시/지원 코드로 현재 주요 경로에 사용되지 않음

4. **자동 업데이트 시스템**
   - 시작 시 npm 레지스트리 확인
   - 자동 설치 및 업데이트

5. **구조화된 알림**
   - 터미널 알림으로 대체 발생 시 사용자에게 정보 제공

## 아키텍처 구조

```
opencode-auto-fallback/
├── index.ts                  # 공개 API: createPlugin 내보내기
├── src/
│   ├── plugin.ts             # 오케스트레이션: 훅 연결, 에러 처리 (~1151라인)
│   ├── session-fork.ts       # 레거리 세션 포킹 (현재 사용되지 않음)
│   ├── types.ts              # 모든 인터페이스/타입 정의
│   ├── config.ts             # 설정 로딩, 자동 생성, 체인 해결
│   ├── decision.ts           # classifyError() - 상태코드 + 재시도 가능 여부 분류
│   ├── session-state.ts      # 세션별 쿨다운 + 백오프 레벨 관리
│   ├── provider-state.ts     # 모덌별 타이머 쿨다운 관리
│   ├── message.ts            # 메시지 추출 로직
│   ├── constants.ts          # HTTP 상태 코드 집합 + 백오프 기준
│   ├── log.ts                # 파일 로깅 시스템
│   ├── update-checker.ts     # npm 레지스트리를 통한 자동 업데이트
│   ├── adapters/sdk-adapter.ts  # SDK → 도메인 타입 변환 (제로 `as any`)
│   ├── state/context-state.ts   # 중앙 집중식 상태 관리 (13개 Map)
│   └── __tests__/           # 테스트 스위트 (84개 테스트)
├── docs/fallback.schema.json # JSON 스키마 유효성 검증
├── package.json
├── tsconfig.json
└── bun.lock
```

## 주요 모듈 분석

### 1. plugin.ts (메인 오케스트레이터)
**역할**: 이벤트 처리, 에러 분류, 재시도 로직, 대체 체인 실행, 대형 컨텍스트 상태 관리

**핵심 함수**:
- `createPlugin()`: 플러그인 엔트리 포인트
- `handleRetry()`: 재시도 로직 구현
- `handleImmediate()`: 즉시 대체 처리
- `tryFallbackChain()`: 대체 모덌 체인 실행
- `handleLargeContextSwitch()`: 대형 컨텍스트 모덌 전환 (인플레이스)
- `handleLargeContextReturn()`: 원본 모덌 복귀 준비
- `handleLargeContextCompletion()`: 컴팩션 완료 후 처리

**이벤트 핸들러**:
- `session.error`: 에러 탐지 및 분류
- `session.status`: 속도 제한 패턴 탐지
- `session.idle`: 컨텍스트 임계값 확인 및 대형 컨텍스트 전환
- `experimental.session.compacting`: 컴팩션 시 동작 제어 (상태 기반)
- `experimental.compaction.autocontinue`: 자동 계속 실행 제어 (타입 불일치 존재)

**중요 아키텍처 결정**:
- 상태 머신 기반 대형 컨텍스트 관리 (pending → active → summarizing)
- 원본 세션 내에서의 모덌 전환 (세션 포킹 아님)
- 구조화된 메시지 주입을 통한 컨텍스트 유지
- 원자적 상태 설정 (await 전에 "pending" 상태 설정)

### 2. decision.ts (에러 분류기)
**분류 우선순위**:
1. 쿨다운 활성화 → 무시
2. HTTP 401/402/403 → 즉시 대체
3. `isRetryable === true` → 재시도
4. `isRetryable === false` → 즉시 대체
5. HTTP 429/5xx → 재시도
6. 기본값 → 재시도 (안전망)

### 3. config.ts (설정 관리)
**자동 생성**: 첫 실행 시 `~/.config/opencode/fallback.json` 생성
**에이전트별 구성**: 각 에이전트에 맞는 대체 모덌 체인
**모덌 해석**: 문자열 → `ResolvedModel` 객체 변환
**정규화**: 에이전트 이름 정규화 (공백 제거, 소문자 변환)

### 4. 대형 컨텍스트 대체 구현 (현재 활성 경로)
**현재 주요 구현**: 세션 포킹이 아닌 인플레이스 모덌 전환 사용

**상태 머신** (3단계 + 기본 상태):
```typescript
type LargeContextPhase = "pending" | "active" | "summarizing" | null
// null = "no phase" (정상 상태)
```

**실제 실행 흐름** (임계값/오류 기반 인플레이스 전환):
1. **자동 컴팩션 전역 비활성화**: `largeContextFallback` 존재 시 `config` 훅에서 `compaction.auto = false` 설정
2. **컨텍스트 임계값 감지**: `session.idle` 훅에서 컨텍스트 사용량 확인 (기본 80% 또는 `compaction.reserved`)
3. **대형 모덌 전환**: 원본 세션 내에서 직접 모덌 전환 (현재 활성 경로)
   - 상태 "pending"으로 원자적 설정
   - `session.prompt()`로 대형 모덌 직접 호출
   - 상태 "active"로 전환
4. **활성 단계 작업**: 대형 모덌으로 작업 수행
5. **원본 모덌 복귀**: `session.idle`에서 컴팩션 트리거, 원본 모덌으로 복귀 준비
6. **전환 완료 후 상태 삭제**: 복귀 완료 후 `largeContextPhase` 삭제

**session-fork.ts의 역할**: 레거시/잔여 코드로, 테스트되지만 현재 주요 대형 컨텍스트 흐름에는 사용되지 않음
- `forkSessionForLargeContext()` 존재하나 활성 경로에서 import/use되지 않음
- `injectForkResult()`, fork-tracking 훅들 레거시 호환성 코드로 유지

### 5. 상태 관리 (state/context-state.ts)
**13개 중앙 집중식 Map**:
- `activeFallbackParams`: 대체 모덌 파라미터
- `largeContextSessions`: 대형 컨텍스트 전환 전 원본 모덌
- `currentModelSessions`: 세션별 현재 모덌
- `sessionCooldownModel`: 쿨다운 모덌 추적
- `largeContextPhase`: 대형 컨텍스트 상태 관리
- `modelContextLimits`: 모덌별 컨텍스트 제한
- `sessionOriginalAgent`: 원본 에이전트 저장
- `forkTracking`: 포킹 세션 추적 (레거시)
- `compactionReserved`: 컴팩션 예약 토큰
- `compactionTarget`: 컴팩션 대상 구분

### 6. SDK 어댑터 (adapters/sdk-adapter.ts)
**역할**: SDK 타입과 도메인 타입 간의 타입 안전한 변환
**특징**: 제로 `as any` 사용, 완전 타입 안전성

## 설정 구조

```jsonc
{
  "enabled": true,
  "defaultFallback": ["anthropic/claude-opus-4-7"],
  "agentFallbacks": {
    "reviewer": [
      "zai-coding-plan/glm-5.1",
      {
        "model": "openai/gpt-5.5",
        "temperature": 0.5,
        "reasoningEffort": "medium"
      }
    ]
  },
  "cooldownMs": 60000,
  "maxRetries": 2,
  "logging": false,
  "largeContextFallback": {
    "agents": ["sisyphus", "explore"],
    "model": "openai/gpt-5.5",
    "minContextRatio": 0.1
  }
}
```

**설정 로딩 및 유효성 검증**:
- **자동 생성**: 첫 실행 시 `~/.config/opencode/fallback.json` 생성
- **JSON 파싱**: `loadConfig()`은 JSON 파싱, 기본값 적용, 정규화 수행
- **유효성 검증 제한**: `fallback.schema.json`는 문서/에디터 지원용으로, 실행 시 유효성 검증 없음
- **오류 처리**: 파싱/읽기 실패 시 자동으로 기본값으로 대체

## TypeScript 구현 상세

### 타입 안전성 수준
- **엄격 TypeScript 통과**: `"strict": true` 활성화, `tsc --noEmit` 에러 없음
- **SDK/런타임 갭**: 타입 어설션으로 처리되는 경계 존재
- **어댑터 계층**: `src/adapters/sdk-adapter.ts`는 완전 타입 안전

### 타입 갭 및 타입 어설션
1. **`as any` 사용** (3곳):
   - 위치: `src/plugin.ts` 582, 589, 590라인
   - 목적: experimental 컴팩션 설정 접근 (SDK 제한사항)
   - **결과**: 엄격 TypeScript 통과하지만 런타임 경계 존재

2. **실험적 훅 타입 불일치**:
   - `experimental.compaction.autocontinue` 시그니처 불일치
   - 플러그인: `{ sessionID, agent, model? }`
   - SDK: `{ sessionID, agent, model, provider, message, overflow }`
   - 영향: 수동/자동 컴팩션 구분 불가능

3. **TUI API 런타임 타입 갭**:
   - 터미널 UI API는 런타임에 존재하지만 SDK 타입에 없음
   - 해결: 인터섹션 타입으로 안전한 접근

4. **배열 타입 어설션** (4곳):
   - SDK 응답 데이터 완전 타입화되지 않음
   - 타입 좁임으로 안전성 향상

5. **chat.params 출력 구조 불일치**:
   - `output.options.maxTokens` vs 예상 `output.maxOutputTokens`
   - 잠재적 파라미터 적용 문제

### SDK 버전 드리프트
- **플러그인**: v1 SDK 타입 사용 (`@opencode-ai/plugin": "^1.0.0`)
- **런타임**: v2 SDK 타입 사용
- **영향**: `ContextOverflowError` 등 v2 특정 타입 누락

## 개발 환경

### 의존성
- **peerDependencies**: `@opencode-ai/plugin >= 1.0.0`
- **개발 도구**: TypeScript, Vitest, Bun
- **빌드**: 빌드 없음 (`.ts` 파일 직접 배포)

### 테스트 전략
- **테스트 프레임워크**: Vitest (84개 테스트)
- **테스트 유형**:
  - `plugin.test.ts`: 통합 테스트
  - `pure-functions.test.ts`: 순수 함수 단위 테스트
  - `error-classification.test.ts`: 에러 분류 테스트
  - `provider-state.test.ts`: 공급자 상태 테스트
- **테스트 패턴**: `createMockContext()` 팩토리 사용

### CI/CD 파이프라인
- **배포 트리거**: `package.json` 버전 변경 시 자동 배포
- **게시 전략**: npm 공개 팩키지로 게시
- **릴리즈**: GitHub Actions 자동 릴리즈 생성
- **품질 게이트**: **없음** - 테스트 및 타입 체크는 수동 실행

## 핵심 아키텍처 결정

1. **빌드 없음**: 원본 `.ts` 파일 직접 배포
2. **엄격 TypeScript**: 대부분 타입 안전, 일부 런타임 타입 갭 존재
3. **ESM 전용**: `"type": "module"` 사용
4. **모듈 레벨 상태**: Map 기반 상태 저장소 (재시작 시 소실)
5. **우선순위 기반 에러 분류**: 쿨다운 → HTTP 상태 → isRetryable → 상태 휴리스틱 → 기본값
6. **3계층 컨텍스트 창**: SDK 메타데이터 → 설정 → 빌인 폴백
7. **원자적 상태 설정**: await 전 "pending" 상태 설정으로 경쟁 조건 방지
8. **모덌 인식 쿨다운**: 현재 모덌이 쿨다운 모덌과 다를 경우 에러 통과 허용
9. **플러그인 목록 우선**: 다른 폴백 플러그인 전에 배치하여 에러 우선 처리
10. **비동기 로깅**: `appendFile` 사용, 설정은 동기 `readFileSync/writeFileSync` 사용

## 주요 운영 트레이드오프
- **인메모리 `Map` 기반 상태**: 재시작 시 상태 소실, 플러그인 수명 주기에 적합
- **런타임 패키지 캐시 변경**: 자동 업데이트가 설치된 패키지 캐시를 런타임에 수정
- **CI 품질 게이트 부재**: 게이트 워크플로우는 테스트/타입 체크 없이 바로 게시
- **알 수 없는 오류 기본값 재시도**: 인식되지 않은 오류는 재시도로 처리 (안전망)
- **글로벌 컴팩션 비활성화**: 대형 컨텍스트 지원을 위해 자동 컴팩션 전역 비활성화
- **수동 컴팩션 접근**: 플러그인이 명시적 `session.summarize()` 호출로 컴팩션 동작 모방

## 알려된 제한사항
- 동기 `readFileSync/writeFileSync`와 비동기 `appendFile/mkdir` 혼용
- 상수로 추출된 지연 시간 (`ABORT_DELAY_MS`, `REVERT_DELAY_MS`)
- **런타임 설정 검증 제한**: JSON 스키마는 문서/에디터 지용, 실행 시 유효성 검증 없음
- SDK 버전 드리프트 (v1 플러그인 vs v2 런타임)
- **CI 품질 게이트 부재**: 게시 전 테스트 및 타입 체크 실행 안 함

## 사용 방법

1. **플러그인 등록**: `~/.config/opencode/opencode.json`에 추가
2. **설정 파일**: `~/.config/opencode/fallback.json` 커스터마이징
3. **배포**: 자동 업데이트 시스템이 관리

## 프로젝트 평가

### 강점
- **강력한 에러 분류 시스템** with 우선순위 기반 결정
- **이중 계층 재시도 전략**: 일시적 오류에 대한 지수 백오프, 영구 오류에 대한 즉시 대체
- **정확한 대형 컨텍스트 지원** with 상태 기반 모덌 전환
- **제로 설정 시작** with sensible 기본값
- **포괄적 테스트** with Vitest
- **타입 안전성** 엄격 TypeScript with 일부 런타임 타입 갭
- **자동 업데이트** via npm 레지스트리
- **우아한 저하** (toast API, 오류 처리)

### 개선 영역
- **CI 품질 게이트**: 게시 전 테스트 및 타입 체크 실행
- **런타임 설정 유효성 검증**: JSON 스키마 실행 시 검증 추가
- **SDK 버전 통일**: v1과 v2 타입 드리프트 해결
- **타입 갭 완화**: experimental 훅 타입 정확화

이 `opencode-auto-fallback` 프로젝트는 잘 구조화된 TypeScript 확장으로서 OpenCode 플랫폼에 대한 깊은 이해를 바탕으로 한 지능형 오류 처리 및 대체 메커니즘을 제공합니다.
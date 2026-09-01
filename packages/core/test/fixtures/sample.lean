import Mathlib.Order.Basic

/-- A token carries an expiry. -/
structure Token where
  expiry : Nat
  deriving Repr

namespace Auth

def validAt (t : Token) (now : Nat) : Prop := now < t.expiry

namespace Token

/-- Refreshing a token pushes its expiry forward. -/
def refresh (t : Token) : Token :=
  { t with expiry := bump t.expiry }

private theorem refresh_monotone (t : Token) : t.expiry ≤ (refresh t).expiry := by
  simp [refresh, bump]

protected theorem refresh_sound (t : Token) (now : Nat) : validAt (refresh t) now := by
  simp [validAt, refresh]

end Token

theorem outer_holds : True := trivial

end Auth

section Internals

-- A section bounds variables, not names, so `helper` stays unqualified.
def helper (n : Nat) : Nat := n + 1

end Internals

inductive Color where
  | red
  | green

abbrev Pair := Nat × Nat

class Monoidish (α : Type) where
  unit : α

instance : Monoidish Nat where
  unit := 0

axiom choice_ax : ∀ (α : Type), Nonempty α

opaque secret : Nat

example : 1 = 1 := rfl

namespace Auth.Syntax

declare_syntax_cat authRule

/-- A tactic that discharges an expiry side goal. -/
syntax "expiry_tac" : tactic

syntax (name := refreshTac) "refresh_tac" (ppSpace colGt term)? : tactic

syntax (priority := high) "priority_tac" : tactic

macro "bump_tac" : tactic => `(tactic| simp [bump])

local syntax "file_only_tac" : tactic

scoped syntax "namespace_tac" : tactic

infixl:65 " ⊕' " => Sum

notation "⟦" a "⟧" => Quot.mk _ a

initialize authRef : IO.Ref Nat ← IO.mkRef 0

register_option auth.verbose : Bool := false

register_error_explanation authFailed { }

macro_rules
  | `(tactic| expiry_tac) => `(tactic| simp)

elab "audit_tac" : tactic => pure ()

elab (name := auditWith) "audit_with " t:term : tactic => pure ()

elab "audit_do" : tactic => do
  pure ()

def afterElab : Nat := 0

end Auth.Syntax

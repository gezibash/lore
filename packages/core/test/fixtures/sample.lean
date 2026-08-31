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

# SIM swap guard: turns the operator's SIM swap signal into a decision.
#
# The app queries this package twice per request:
#   1. data.simswap.guard.window_hours, with input {action}, to know which
#      maxAge to send to the operator;
#   2. data.simswap.guard, with the operator's answer in input.signal, and
#      acts on .decision.
#
# Thresholds live in data.simswap.config (data.json), so they can be tuned
# without changing these rules.
package simswap.guard

import rego.v1

cfg := data.simswap.config

window_hours := cfg.windows[input.action]

operator_down if input.signal.status != 200

recent_swap if {
	not operator_down
	input.signal.swapped == true
}

large_payment if {
	input.action == "payment"
	input.amount > cfg.block_above
}

default decision := {
	"result": "allow",
	"rule": "no_recent_swap",
	"reason": "No SIM change inside the window.",
	"obligations": [],
}

decision := {
	"result": cfg.on_error[input.action],
	"rule": "operator_down",
	"reason": sprintf("No SIM swap signal (%s). Falling back to %s.", [object.get(input.signal, "code", "error"), cfg.on_error[input.action]]),
	"obligations": ["log_for_review"],
} if {
	operator_down
}

decision := {
	"result": "block",
	"rule": "swap_large_payment",
	"reason": sprintf("SIM changed in the last %dh and the amount is over %d.", [window_hours, cfg.block_above]),
	"obligations": ["notify_out_of_band"],
} if {
	recent_swap
	large_payment
}

decision := {
	"result": "step_up",
	"rule": "swap_step_up",
	"reason": sprintf("SIM changed in the last %dh. An SMS code to this number proves nothing.", [window_hours]),
	"obligations": ["no_sms_otp", "require_passkey"],
} if {
	recent_swap
	not large_payment
}

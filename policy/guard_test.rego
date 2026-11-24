package simswap.guard_test

import rego.v1

import data.simswap.guard

ok(swapped) := {"status": 200, "swapped": swapped}

test_window_per_action if {
	guard.window_hours == 24 with input as {"action": "login"}
	guard.window_hours == 72 with input as {"action": "payment"}
}

test_clean_login_allowed if {
	guard.decision.result == "allow" with input as {"action": "login", "signal": ok(false)}
}

test_recent_swap_login_steps_up if {
	d := guard.decision with input as {"action": "login", "signal": ok(true)}
	d.result == "step_up"
	"no_sms_otp" in d.obligations
}

test_recent_swap_small_payment_steps_up if {
	guard.decision.result == "step_up" with input as {"action": "payment", "amount": 100, "signal": ok(true)}
}

test_recent_swap_large_payment_blocked if {
	guard.decision.rule == "swap_large_payment" with input as {"action": "payment", "amount": 750, "signal": ok(true)}
}

test_operator_down_login_fails_open if {
	guard.decision.result == "allow" with input as {"action": "login", "signal": {"status": 503, "code": "UNAVAILABLE"}}
}

test_operator_down_payment_held if {
	d := guard.decision with input as {"action": "payment", "amount": 10, "signal": {"status": 503, "code": "UNAVAILABLE"}}
	d.result == "review"
	d.rule == "operator_down"
}

test_thresholds_come_from_data if {
	cfg := {"windows": {"login": 24, "payment": 168}, "block_above": 1000, "on_error": {"login": "allow", "payment": "block"}}
	guard.decision.result == "step_up" with input as {"action": "payment", "amount": 750, "signal": ok(true)} with data.simswap.config as cfg
	guard.window_hours == 168 with input as {"action": "payment"} with data.simswap.config as cfg
}

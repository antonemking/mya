# I read the harness paper with my own loop open

I build Mya, a terminal harness. The model continues a transcript, the harness runs the tools, and the session sits in a file I can open later. I work as an AI architect, and I keep this loop myself because I got tired of arguing about agents I could not inspect. Once you have a loop, the temptation is to hang more on it. A planner. A longer tool list. A summarizer that fires whenever the transcript looks long. Other agents have all of that. I wanted a reason that was not "everyone else shipped it."

So I read [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804) (Fan, Zhang, and coauthors, arXiv:2609.20804). They freeze the execution loop and move one piece: planning, the action space, or context management. Four models, Nemotron-3 at 30B, 120B, and 550B, plus Mistral-Medium-3.5-128B, on SWE-Bench Verified and Terminal-Bench 2.1. Temperature 0, one run per task, 176 settings. Context policies run at 32k, 64k, 96k, and 128k. Planning and the tool list flip only at 128k, under their fullest context policy. A wide window is a different experiment from a tight one.

## What they found

Context management matters when the budget is tight, and most of the gain is that the run does not die. They write that it "becomes increasingly valuable as the context-window budget tightens, with most of its benefit coming from preventing context-overflow failures." Averaged across the models, the success gap between managed context and no management on SWE-Bench shrinks from 35.7 percentage points at 32k to 15.9, 5.5, and 2.7 points at 64k, 96k, and 128k. Terminal-Bench moves the same way, from 9.5 points down to 2.8. Unmanaged overflow falls from 78.7% of SWE-Bench tasks to 8.7%, and from 61.0% to 12.1% on Terminal-Bench. Every managed tier overflows on zero tasks. After that, whatever accuracy is left depends on the model.

The cheap policy is a rule, then a summary. Cut stale bulky tool output first. Pay a model to summarize only if you are still over the line. That staged setup had the lowest mean cost at every budget, because the early cut often made the summary unnecessary. A tool that lets the model pull the cut text back did not help. Recall on versus recall off differs by an equal-weight mean of -0.36 percentage points. In 36 of 64 settings where the tool existed, the model never called it. Mean calls per task fall from 0.540 at 32k to 0.007 at 128k.

Planning changes jobs as the model gets stronger. On Nemotron-3 30B it raises SWE-Bench success by 11.6 percentage points and Terminal-Bench by 4.5, and it costs more. Without a plan, 68.6% of that model's SWE-Bench runs end with no edit. With a plan, 27.8%. The median SWE-Bench run grows from 5 turns without a plan to 40 with one. On Nemotron-3 550B and Mistral-Medium-3.5, the same switch cuts SWE-Bench cost by about 30% and 32%, and success by 2.0 and 0.4 percentage points. The missing turns are mostly checking the work again.

Tools depend on who is holding the shell, and on the task. A predefined tool set raises Nemotron-3 30B by 15.0% on SWE-Bench and 10.1% on Terminal-Bench. On Terminal-Bench, 66% of that model's bash-only runs end after it emits a tool name the registry does not have. For Nemotron-3 550B, bash-only raises success by 3.6% on SWE-Bench and 5.6% on Terminal-Bench, and cuts cost by 53% and 30%. Mistral splits by task: the full tool set wins by 23.2% on repository repair, bash-only by 6.7% on the command-line benchmark. With every tool available, 71.9% of its command-line workspace actions were already bash. They say the crossover points "should therefore be validated before being transferred to other model families," and the tool result is a bundle. Prompt, file-state tracking, and automatic diagnostics move with the tool list.

## What I saw in Mya

Mya is that same loop. One model call, the tools from that response, another call if there were results. Context policy can live in an extension. Core ships none. A normal run sends the transcript until the model stops, the turn cap hits, or the provider rejects the request. The raw response is on the event log. I still have no count of how often overflow is the reason the run ended.

Loaded compaction is their summary-only setup. Past a threshold it summarizes older messages and keeps a tail. No earlier pass stubs out old tool bodies. No recall tool. Original turns stay in the session file, which is the right place for them. The window defaults to 200,000 tokens unless I set it, and that number is not the window of the model I just called. On a small local model the extension can sit idle while the provider stops the run. On a large model the same constant can summarize early. The first trip over the line pays for a summary of the whole head. I do chop one huge tool result when it comes back. A later turn never throws out what has gone stale.

Planning stays off, and that matches the paper's off arm. The prompt names the directory and the tools, says not to guess file contents, and says to answer when the work is done. No plan is pasted back in before later calls. Claude Sonnet 4.5 and GPT-5.5 were not in the study, nor was GPT-4.1. I will treat the first two like their strong models until I measure: expect a shorter, cheaper run, and do not expect an accuracy gain. A small model on an OpenAI-compatible server is the case where a plan might be what gets the run as far as an edit. I have not run that. Planning stays off the default path.

The tool list is already small. Core is read, write, edit, bash, and a check command that reports pass or fail. Search is bash. I kept the file tools a weak model struggles to fake as shell, and I left list, glob, grep, and web fetch out. An unknown name comes back listing the real tools. Their 30B still died on missing names. That error string is not a fix I can borrow.

## What I am changing

First, measure. If my runs die on the turn cap, or just finish, a smarter compactor will not move success. The first change is a log, not a policy. For each run I want the peak context against the model's real window, and whether the run ended because of context or because of the turn cap. I do not have those rates.

Second, if that log says the window is what stops the run, trim before summarizing. Old bulky tool output becomes a short stub. The session file keeps the original. No recall tool. A summary runs only when the stub was not enough. If runs already finish inside the window, this waits.

Third, size the limit to the model that was called. The log should use that window. Compaction still defaults to 200,000, a number I chose. It will fire too early on a large model and never on a small one.

Planning stays an experiment for a weak model, not a default. Grep, glob, and list stay out of core until a weak model here shows it is stuck without them. Read, write, and edit stay.

Harness parts depend on the model and the budget, and sometimes on the task. Measure before adding machinery. A follow-up will come with the overflow numbers from real runs. Then I will know whether the trim is worth writing.

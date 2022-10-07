	lw	0	1	input	r1 = memory[input]
	lw	0	4	SubAdr	prepare to call sub4n. r4=addr(sub4n)
	jalr	4	7		call sub4n; r7=return address r3=answer
	halt
sub4n	lw	0	6	pos1	r6 = 1
	sw	5	7	Stack	save return address on stack
	add	5	6	5	increment stack pointer
	sw	5	1	Stack	save input on stack
	add	5	6	5	increment stack pointer
	add	1	1	1	compute 2*input
	add	1	1	3	compute 4*input into return value
	lw	0	6	neg1	r6 = -1
	add	5	6	5	decrement stack pointer
	lw	5	1	Stack	recover original input
	add	5	6	5	decrement stack pointer
	lw	5	7	Stack	recover original return address
	jalr	7	4		return.  r4 is not restored.
input	.fill	10
pos1	.fill	1
neg1	.fill	-1
SubAdr	.fill	sub4n			contains the address of sub4n
Stack	.fill	0			definition for the start of the stack (value does not matter)

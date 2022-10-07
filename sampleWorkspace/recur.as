	lw	0	1	n	a program to calculate the combination of two numbers
	lw	0	2	r
	lw	0	4	Caddr	load combination function address
	jalr	4	7		call function
	halt
comb	lw	0	6	pos1	r6=1
	sw	5	7	Stack	save return address
	add	5	6	5	increment stack pointer
	sw	5	1	Stack	save input 1
	add	5	6	5	increment stack pointer
	sw	5	2	Stack	save input 2
	add	5	6	5	increment stack pointer
	sw	5	3	Stack	save return value
	beq	2	0	ret1	if input 2=0, return1
	beq	2	1	ret1	if input 2=1, return1
else	lw	0	6	neg1	r6=-1
	add	1	6	1	input 1=input 1-1
	lw	0	6	pos1	r6=1
	add	5	6	5	stack pointer point to new stack
	lw	0	4	Caddr	load combination function address
	jalr	4	7		call function
	lw	0	6	pos1	r6=1
	sw	5	3	Stack	save return value
	add	5	6	5	stack pointer point to new stack
	lw	0	6	neg1	r6=-1
	add	2	6	2	input 2=input 2-1
	lw	0	4	Caddr	load combination function address
	jalr	4	7		call function
	lw	5	6	Stack	r6=return value
	add	3	6	3	return value=return value+return value
	lw	0	6	neg1	r6=-1
	add	5	6	5	decrement stack pointer
	lw	5	2	Stack	recover input 2
	add	5	6	5	decrement stack pointer
	lw	5	1	Stack	recover input 1
	add	5	6	5	decrement stack pointer
	lw	5	7	Stack	recover return address
	add	5	6	5	decrement stack pointer
	jalr	7	4		return
ret1	lw	0	3	pos1	r3=1
	lw	0	6	neg1	r6=-1
	add	5	6	5	decrement stack pointer
	add	5	6	5	decrement stack pointer
	add	5	6	5	decrement stack pointer
	lw	5	7	Stack	recover return address
	add	5	6	5	decrement stack pointer
	jalr	7	4		return
n	.fill	14
r	.fill	7
Caddr	.fill	comb
pos1	.fill	1
neg1	.fill	-1
Stack	.fill	0
